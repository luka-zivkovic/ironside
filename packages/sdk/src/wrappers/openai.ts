import type { IronsideClient, TraceHandle } from "../client.js";
import { errorEndOptions, instrumentAsyncIterable } from "./streaming.js";

// Wraps the OpenAI Node SDK's chat.completions.create() to automatically
// record a generation. Verified against openai@6.46.0: usage lives at
// completion.usage.{prompt_tokens,completion_tokens} for Chat Completions
// (the Responses API — client.responses.create — uses a different field
// vocabulary, input_tokens/output_tokens, and is not wrapped here; only
// Chat Completions, still the most common call site, is covered in this
// pass). client.chat.completions is a plain wrappable instance property,
// not a sealed/frozen internal — this is the same interception pattern
// OpenInference and Langfuse's own OpenAI integrations use.
//
// Patches the passed-in client's create() method in place and returns the
// SAME reference, rather than shallow-copying the client object. A shallow
// copy (`{...client}`) would drop every other resource (embeddings,
// images, ...) and any internal state accessed via `this` inside the SDK's
// own methods — patch-in-place is what real client instrumentation
// libraries (OpenInference, Langfuse) do for exactly this reason.
//
// STREAMING (M9-07) — `create({..., stream: true})` resolves to a Stream
// (async iterable of ChatCompletionChunk). The stream's asyncIterator is
// patched in place (wrappers/streaming.ts) so text deltas, streamed tool
// calls, and the final usage chunk are accumulated as the CALLER iterates,
// and the generation ends when iteration finishes (done, early break, or
// mid-stream error). Usage is only present on the final (empty-choices)
// chunk when the caller set `stream_options: {include_usage: true}` — the
// wrapper deliberately does NOT inject that option itself: mutating the
// wire request can break OpenAI-compatible backends that reject unknown
// fields, and a tracing wrapper silently changing what's sent to the
// provider is worse than missing token counts. Without it, the streamed
// generation records output text but no usageDetails (documented in the
// README quickstart).

export interface WrapOpenAIOptions {
  /** Attach generations to an existing trace instead of creating a new standalone trace per call. */
  trace?: TraceHandle;
}

// Request sampling parameters worth recording as modelParameters — verified
// against the Chat Completions request schema (openai@6.46.0). Kept to the
// common cross-provider set (temperature/top_p/max_tokens/penalties/seed);
// only fields actually present on the request are ever recorded.
interface RequestModelParameters {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
}

function extractModelParameters(
  body: RequestModelParameters | undefined
): Record<string, string | number | boolean | null> | undefined {
  if (!body) return undefined;
  const entries = (
    ["temperature", "top_p", "max_tokens", "max_completion_tokens", "presence_penalty", "frequency_penalty", "seed"] as const
  )
    .filter((key) => body[key] !== undefined)
    .map((key) => [key, body[key]] as [string, number]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface ChatCompletionLike {
  model?: string;
  usage?: ChatCompletionUsage;
}

function usageDetailsFrom(usage: ChatCompletionUsage | undefined) {
  if (!usage) return undefined;
  const details = {
    ...(usage.prompt_tokens !== undefined && { input_tokens: usage.prompt_tokens }),
    ...(usage.completion_tokens !== undefined && { output_tokens: usage.completion_tokens })
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

// Streamed chunk shape (ChatCompletionChunk): delta carries content and
// incremental tool_calls (arguments arrive as string fragments to
// concatenate, keyed by index); usage arrives on a final chunk with empty
// choices, only under stream_options.include_usage.
interface ChunkToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionChunkLike {
  model?: string;
  usage?: ChatCompletionUsage | null;
  choices?: Array<{
    index?: number;
    delta?: { content?: string | null; tool_calls?: ChunkToolCallDelta[] };
    finish_reason?: string | null;
  }>;
}

interface AccumulatedToolCall {
  id?: string;
  type?: string;
  function: { name?: string; arguments: string };
}

interface AccumulatedChoice {
  content: string;
  sawContent: boolean;
  toolCalls: AccumulatedToolCall[];
  finishReason?: string;
}

function assembleMessage(choice: AccumulatedChoice) {
  const assembledToolCalls = choice.toolCalls.filter(Boolean);
  return {
    role: "assistant",
    content: choice.sawContent ? choice.content : null,
    ...(assembledToolCalls.length > 0 && { tool_calls: assembledToolCalls })
  };
}

function createChunkAccumulator() {
  // Keyed by choice.index — an n>1 request streams every choice's deltas
  // interleaved in the same chunk sequence, so reading only choices[0]
  // would silently truncate the response to a fraction of one choice
  // (review finding, PR #39).
  const choices = new Map<number, AccumulatedChoice>();
  let usage: ChatCompletionUsage | undefined;
  let responseModel: string | undefined;

  return {
    onChunk(raw: unknown) {
      const chunk = raw as ChatCompletionChunkLike;
      if (chunk.model) responseModel = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      for (const choice of chunk.choices ?? []) {
        const index = choice.index ?? 0;
        let slot = choices.get(index);
        if (!slot) {
          slot = { content: "", sawContent: false, toolCalls: [] };
          choices.set(index, slot);
        }
        if (choice.finish_reason) slot.finishReason = choice.finish_reason;
        if (typeof choice.delta?.content === "string") {
          slot.content += choice.delta.content;
          slot.sawContent = true;
        }
        for (const tc of choice.delta?.tool_calls ?? []) {
          const toolSlot = (slot.toolCalls[tc.index] ??= { function: { arguments: "" } });
          if (tc.id) toolSlot.id = tc.id;
          if (tc.type) toolSlot.type = tc.type;
          if (tc.function?.name) toolSlot.function.name = tc.function.name;
          if (tc.function?.arguments) toolSlot.function.arguments += tc.function.arguments;
        }
      }
    },
    endOptions() {
      const sorted = [...choices.entries()].sort(([a], [b]) => a - b);
      const usageDetails = usageDetailsFrom(usage);
      // Single choice (the overwhelmingly common case): output is the
      // assistant message itself. n>1: output mirrors the non-streaming
      // completion's choices array so no choice is dropped.
      const single =
        sorted.length === 0
          ? { content: "", sawContent: false, toolCalls: [] } // empty stream: a bare content-null message
          : sorted.length === 1
            ? sorted[0]![1]
            : undefined;
      const output = single
        ? assembleMessage(single)
        : {
            choices: sorted.map(([index, choice]) => ({
              index,
              message: assembleMessage(choice),
              ...(choice.finishReason && { finish_reason: choice.finishReason })
            }))
          };
      const finishReason = single?.finishReason;
      return {
        output,
        ...(usageDetails && { usageDetails }),
        metadata: {
          streamed: "true",
          ...(responseModel && { response_model: responseModel }),
          ...(finishReason && { finish_reason: finishReason })
        }
      };
    }
  };
}

// `never[]` parameters make this satisfiable by the real OpenAI client's
// overloaded create() — a `(...args: unknown[])` signature is
// contravariantly INCOMPATIBLE with any function taking typed params, so
// the real SDK class would fail the T constraint (caught by the real-SDK
// conformance tests, which the fake-client unit tests never exercised).
interface ChatCompletionsLike {
  create: (...args: never[]) => unknown;
}

interface OpenAILike {
  chat: { completions: ChatCompletionsLike };
}

/**
 * Wraps an OpenAI client instance so every chat.completions.create() call
 * — streaming or not — is automatically recorded as a generation. Mutates
 * client.chat.completions in place and returns the same client reference
 * for convenient chaining (`const client = wrapOpenAI(new OpenAI(...), ironside)`).
 *
 * Safe to call more than once on the same client — re-wrapping is detected
 * and is a no-op, rather than nesting a second wrapper around the first
 * (which would silently double-record every call: two traces, two
 * generations, per real API call).
 */
export function wrapOpenAI<T extends OpenAILike>(
  client: T,
  ironside: IronsideClient,
  options: WrapOpenAIOptions = {}
): T {
  const completions = client.chat.completions as ChatCompletionsLike & {
    __ironsideWrapped?: boolean;
  };
  if (completions.__ironsideWrapped) return client;

  const originalCreate = completions.create.bind(completions) as (
    ...args: unknown[]
  ) => Promise<unknown>;

  const wrappedCreate = async (...args: unknown[]): Promise<unknown> => {
    const requestBody = args[0] as
      | (RequestModelParameters & { model?: string; messages?: unknown; stream?: boolean })
      | undefined;

    const modelParameters = extractModelParameters(requestBody);
    const trace = options.trace ?? ironside.trace({ name: "openai.chat.completions.create" });
    const generation = trace.generation({
      name: "openai.chat.completions.create",
      ...(requestBody?.model && { model: requestBody.model }),
      ...(modelParameters && { modelParameters }),
      input: requestBody?.messages
    });

    try {
      const result = await originalCreate(...args);

      if (requestBody?.stream) {
        const accumulator = createChunkAccumulator();
        return instrumentAsyncIterable(result, accumulator.onChunk, ({ error, consumed }) => {
          if (error) generation.end(errorEndOptions(error));
          else if (consumed) generation.end(accumulator.endOptions());
          // !consumed: the result wasn't iterable at all (unexpected SDK
          // shape) — end with what we know rather than dangle forever.
          else generation.end({ metadata: { streamed: "true" } });
        });
      }

      const completion = result as ChatCompletionLike;
      const usageDetails = usageDetailsFrom(completion.usage);
      generation.end({
        output: completion,
        ...(usageDetails && { usageDetails })
      });
      return result;
    } catch (error) {
      generation.end(errorEndOptions(error));
      throw error;
    }
  };
  completions.create = wrappedCreate as typeof completions.create;
  Object.defineProperty(completions, "__ironsideWrapped", {
    value: true,
    enumerable: false
  });

  return client;
}
