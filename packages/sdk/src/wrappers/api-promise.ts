// Both provider SDKs' create() returns an APIPromise: a Promise with extra
// methods that callers and the SDKs' own helpers use. Anthropic's
// messages.stream() calls withResponse() on create()'s result, and OpenAI's
// chat.completions.parse() calls _thenUnwrap() on it. A wrapper that awaits
// create() returns a plain Promise instead, and those helpers throw
// ("withResponse is not a function"). recordResult derives the wrapper's
// result with the SDK's own _thenUnwrap, so the caller still gets an
// APIPromise, with every method it had.

interface ApiPromiseLike {
  _thenUnwrap(transform: (value: unknown) => unknown): ApiPromiseLike;
  asResponse(): Promise<unknown>;
  /** The step that reads and parses the response body, and applies _thenUnwrap's transform. */
  parseResponse?: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Returns what create() returned, with `onValue` applied to its result, and
 * `onError` called once if the call fails.
 *
 * - `onValue` runs on the parsed result when the caller reads it (awaiting
 *   it, withResponse(), or an SDK helper) and returns what the caller
 *   receives.
 * - A failed request (an error status, a connection failure, a timeout or
 *   abort before the response) is observed through asResponse(), which does
 *   not read the response body, so observing it never consumes a body the
 *   caller may read itself, and it is recorded even if the result is never
 *   read. Unlike the unwrapped SDK, such a failure then raises no unhandled
 *   rejection when nothing reads the result.
 * - A failure after the response arrived (a body that is cut off or fails to
 *   parse, an abort while it downloads, or `onValue` itself throwing) is
 *   observed by hooking the result's parseResponse, which the request's
 *   failures never reach.
 * - A result that is never read is never parsed, so a successful call whose
 *   result is ignored, or read only as the raw response (asResponse()), leaves
 *   its generation open, like a stream that is never iterated.
 *
 * Anything that is not an APIPromise (another SDK version, a test double) is
 * handled as a plain promise.
 */
export function recordResult(
  pending: unknown,
  onValue: (value: unknown) => unknown,
  onError: (error: unknown) => void
): unknown {
  let settled = false;
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    onError(error);
  };
  const succeed = (value: unknown) => {
    const result = onValue(value);
    settled = true;
    return result;
  };

  const apiPromise = pending as Partial<ApiPromiseLike> | null | undefined;
  if (typeof apiPromise?._thenUnwrap === "function" && typeof apiPromise.asResponse === "function") {
    apiPromise.asResponse().then(undefined, fail);
    const derived = apiPromise._thenUnwrap(succeed);
    const parseResponse = derived.parseResponse;
    if (typeof parseResponse === "function") {
      // An instance property the SDK calls at parse time, also from promises
      // derived from this one (OpenAI's parse() calls _thenUnwrap on it).
      derived.parseResponse = async (...args: unknown[]) => {
        try {
          return await parseResponse.apply(derived, args);
        } catch (error) {
          fail(error);
          throw error;
        }
      };
    }
    return derived;
  }
  return Promise.resolve(pending).then(
    (value) => {
      try {
        return succeed(value);
      } catch (error) {
        fail(error);
        throw error;
      }
    },
    (error: unknown) => {
      fail(error);
      throw error;
    }
  );
}
