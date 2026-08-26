// Shared machinery for tracing streamed responses (M9-07). Both provider
// SDKs return a Stream object that is an async iterable with extra API
// surface (.tee(), .controller, .toReadableStream(), ...). Returning our
// own wrapper generator would silently break every caller using that
// surface, so instead the stream's [Symbol.asyncIterator] is patched IN
// PLACE and the SAME object is returned — identical to how the wrappers
// patch client.chat.completions.create itself.
//
// The generation can only be finalized when the caller actually consumes
// the stream (that's when the text/usage exists at all). Three exits all
// funnel into one finalize call: normal completion (done), early break
// (the iterator's return()), and a mid-stream error (next() rejecting or
// throw()). A stream the caller never iterates records its start event
// but never ends — visible in the UI as a dangling in-progress
// generation, which is the honest representation of what happened.
//
// KNOWN LIMIT — .tee(): each branch iterates through the patched
// asyncIterator, so chunks from both branches feed one accumulator
// (double-counted text). finalize still fires exactly once. tee'd +
// wrapped is rare enough that correct-single-stream beats a per-iterator
// accumulator design that couldn't merge usage sanely anyway.

/**
 * Patches `stream`'s async iterator in place so every yielded chunk feeds
 * `onChunk` and exactly one of done/break/error triggers `onFinish`.
 * Returns the same object. If the value isn't async-iterable at all
 * (unexpected SDK shape), it is returned untouched and `onFinish` fires
 * immediately with `{ consumed: false }` so the generation isn't left
 * dangling by our own bug.
 */
export function instrumentAsyncIterable<T>(
  stream: T,
  onChunk: (chunk: unknown) => void,
  onFinish: (outcome: { error?: unknown; consumed: boolean }) => void
): T {
  const iterable = stream as T & {
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  };
  if (typeof iterable?.[Symbol.asyncIterator] !== "function") {
    onFinish({ consumed: false });
    return stream;
  }

  let finished = false;
  const finishOnce = (outcome: { error?: unknown }) => {
    if (finished) return;
    finished = true;
    onFinish({ ...outcome, consumed: true });
  };

  const originalFactory = iterable[Symbol.asyncIterator]!.bind(iterable);
  iterable[Symbol.asyncIterator] = () => {
    const inner = originalFactory();
    return {
      async next(): Promise<IteratorResult<unknown>> {
        try {
          const result = await inner.next();
          if (result.done) finishOnce({});
          else onChunk(result.value);
          return result;
        } catch (error) {
          finishOnce({ error });
          throw error;
        }
      },
      // Called on `break`/`return` inside a for-await — the caller chose
      // to stop early; what accumulated so far is the real output.
      async return(value?: unknown): Promise<IteratorResult<unknown>> {
        finishOnce({});
        if (inner.return) return inner.return(value);
        return { done: true, value: undefined };
      },
      async throw(error?: unknown): Promise<IteratorResult<unknown>> {
        finishOnce({ error });
        if (inner.throw) return inner.throw(error);
        throw error;
      }
    };
  };
  return stream;
}

/** Shared error→end mapping so streamed and non-streamed failures record identically. */
export function errorEndOptions(error: unknown): {
  level: "error";
  statusMessage: string;
} {
  return {
    level: "error",
    statusMessage: error instanceof Error ? error.message : String(error)
  };
}
