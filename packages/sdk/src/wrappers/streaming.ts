// Shared machinery for tracing streamed responses (M9-07). Both provider
// SDKs return a Stream object that is an async iterable with extra API
// surface (.tee(), .controller, .toReadableStream(), ...). Returning our
// own wrapper generator would silently break every caller using that
// surface, so instead the stream is instrumented IN PLACE and the SAME
// object is returned — identical to how the wrappers patch
// client.chat.completions.create itself.
//
// The OpenAI and Anthropic streams keep their iterator factory as an
// instance `iterator` method, which [Symbol.asyncIterator]() and tee() both
// call, and toReadableStream() goes through [Symbol.asyncIterator]. Wrapping
// `iterator` therefore records every way of reading the stream, and a
// tee'd stream exactly once: tee() reads the one underlying iterator and
// hands each chunk to both branches. [Symbol.asyncIterator] is patched as
// well, for a stream whose [Symbol.asyncIterator] does not go through
// `iterator`; an iterator the patched `iterator` already made is passed
// through, so each chunk is recorded once either way. Any other async
// iterable gets only its [Symbol.asyncIterator] patched.
//
// The generation can only be finalized when the caller actually consumes
// the stream (that's when the text/usage exists at all). Three exits all
// funnel into one finalize call: normal completion (done), early break
// (the iterator's return()), and a mid-stream error (next() rejecting or
// throw()). A stream the caller never iterates records its start event
// but never ends — visible in the UI as a dangling in-progress
// generation, which is the honest representation of what happened.
//
// A tee'd stream that no branch reads to the end never reaches the end of the
// underlying iterator, so its generation stays open like an unconsumed one.
// The SDKs' tee branches have no return(), so a `break` in a branch neither
// records the output nor cancels the request.

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
    iterator?: () => AsyncIterator<unknown>;
    tee?: unknown;
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

  const instrument = (inner: AsyncIterator<unknown>): AsyncIterableIterator<unknown> => ({
    // Async-iterable itself, like the generator it replaces.
    [Symbol.asyncIterator]() {
      return this;
    },
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
  });

  const instrumented = new WeakSet<object>();
  if (typeof iterable.iterator === "function" && typeof iterable.tee === "function") {
    const originalIterator = iterable.iterator.bind(iterable);
    iterable.iterator = () => {
      const iterator = instrument(originalIterator());
      instrumented.add(iterator);
      return iterator;
    };
  }
  const originalFactory = iterable[Symbol.asyncIterator]!.bind(iterable);
  iterable[Symbol.asyncIterator] = () => {
    const iterator = originalFactory();
    return instrumented.has(iterator) ? iterator : instrument(iterator);
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
