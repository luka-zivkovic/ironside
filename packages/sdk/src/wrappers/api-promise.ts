// Both provider SDKs' create() returns an APIPromise: a Promise with extra
// methods that callers and the SDKs' own helpers use. Anthropic's
// messages.stream() calls withResponse() on create()'s result, and OpenAI's
// chat.completions.parse() calls _thenUnwrap() on it. A wrapper that awaits
// create() returns a plain Promise instead, and those helpers throw
// ("withResponse is not a function"). recordResult derives the wrapper's
// result with the SDK's own _thenUnwrap, so the caller still gets an
// APIPromise, with every method it had.

interface ApiPromiseLike {
  _thenUnwrap(transform: (value: unknown) => unknown): unknown;
  asResponse(): Promise<unknown>;
}

/**
 * Returns what create() returned, with `onValue` applied to its result, and
 * `onError` called if the request fails.
 *
 * - `onValue` runs on the parsed result when the caller reads it (awaiting
 *   it, withResponse(), or an SDK helper), as it did when the wrapper awaited
 *   create(), and returns what the caller receives.
 * - A failed request is observed through asResponse(), which does not read
 *   the response body, so observing it never consumes a body the caller may
 *   read itself.
 * - A caller that reads only the raw response (asResponse()) never parses
 *   the result, so `onValue` does not run and its generation stays open, like
 *   a stream that is never iterated. A response body that fails to parse is
 *   not observed either.
 *
 * Anything that is not an APIPromise (another SDK version, a test double) is
 * handled as a plain promise, as before.
 */
export function recordResult(
  pending: unknown,
  onValue: (value: unknown) => unknown,
  onError: (error: unknown) => void
): unknown {
  const apiPromise = pending as Partial<ApiPromiseLike> | null | undefined;
  if (typeof apiPromise?._thenUnwrap === "function" && typeof apiPromise.asResponse === "function") {
    apiPromise.asResponse().then(undefined, onError);
    return apiPromise._thenUnwrap((value) => onValue(value));
  }
  return Promise.resolve(pending).then(onValue, (error: unknown) => {
    onError(error);
    throw error;
  });
}
