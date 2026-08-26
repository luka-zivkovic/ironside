import type { IronsideClient, TraceHandle } from "../client.js";
import { errorEndOptions, instrumentAsyncIterable } from "./streaming.js";

// Wraps the Anthropic Node SDK's messages.create() to automatically record
// a generation. Verified against @anthropic-ai/sdk@0.111.0: usage lives at
// message.usage.{input_tokens,output_tokens} (snake_case — same field
// names as OpenAI's Responses API, but this is Anthropic's only call
// path, unlike OpenAI's Chat-Completions-vs-Responses split). model lives
// at message.model. client.messages is a plain wrappable instance
// property; patched in place, same rationale as wrapOpenAI.
//
// STREAMING (M9-07) — `create({..., stream: true})` resolves to a Stream
// of RawMessageStreamEvents. The stream's asyncIterator is patched in
// place (wrappers/streaming.ts) and the Message is reassembled from the
// event protocol as the caller iterates: message_start carries the model
// and input_tokens, content_block_start/content_block_delta carry text
// and tool_use blocks (tool input arrives as partial_json string
// fragments), and the final message_delta carries the cumulative
// output_tokens and stop_reason — so unlike OpenAI (which hides usage
// behind stream_options.include_usage), a streamed Anthropic call always
// records full usage. The `messages.stream()` helper is NOT wrapped —
// it builds its own request path; only create() calls are traced.

export interface WrapAnthropicOptions {
  /** Attach generations to an existing trace instead of creating a new standalone trace per call. */
  trace?: TraceHandle;
}

// Request sampling parameters worth recording as modelParameters — verified
// against the Messages API request schema (@anthropic-ai/sdk@0.111.0).
// Only fields actually present on the request are ever recorded.
interface RequestModelParameters {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
}

function extractModelParameters(
  body: RequestModelParameters | undefined
): Record<string, string | number | boolean | null> | undefined {
  if (!body) return undefined;
  const entries = (["temperature", "top_p", "top_k", "max_tokens"] as const)
    .filter((key) => body[key] !== undefined)
    .map((key) => [key, body[key]] as [string, number]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface MessageLike {
  model?: string;
  usage?: MessageUsage;
}

// `never[]` params so the real Anthropic client's overloaded create()
// satisfies the constraint — same contravariance reasoning as wrapOpenAI.
interface MessagesLike {
  create: (...args: never[]) => unknown;
}

interface AnthropicLike {
  messages: MessagesLike;
}

function usageDetailsFrom(usage: MessageUsage | undefined) {
  if (!usage) return undefined;
  const details = {
    ...(usage.input_tokens !== undefined && { input_tokens: usage.input_tokens }),
    ...(usage.output_tokens !== undefined && { output_tokens: usage.output_tokens })
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

// Streamed event protocol (RawMessageStreamEvent), verified against
// @anthropic-ai/sdk@0.111.0 + docs.anthropic.com/en/docs/build-with-claude/streaming.
interface StreamEventLike {
  type?: string;
  index?: number;
  message?: { model?: string; usage?: MessageUsage };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    text?: string;
    thinking?: string;
    signature?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: MessageUsage;
}

type AccumulatedBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id?: string; name?: string; partialJson: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: string; [key: string]: unknown };

function createEventAccumulator() {
  const blocks: AccumulatedBlock[] = [];
  let responseModel: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let stopReason: string | undefined;

  return {
    onEvent(raw: unknown) {
      const event = raw as StreamEventLike;
      switch (event.type) {
        case "message_start":
          responseModel = event.message?.model;
          inputTokens = event.message?.usage?.input_tokens;
          outputTokens = event.message?.usage?.output_tokens;
          break;
        case "content_block_start": {
          const block = event.content_block;
          if (event.index === undefined || !block) break;
          if (block.type === "text") {
            blocks[event.index] = { type: "text", text: block.text ?? "" };
          } else if (block.type === "tool_use") {
            blocks[event.index] = {
              type: "tool_use",
              ...(block.id && { id: block.id }),
              ...(block.name && { name: block.name }),
              partialJson: ""
            };
          } else if (block.type === "thinking") {
            // Extended-thinking blocks stream as thinking_delta text plus a
            // final signature_delta (the signature is required to round-trip
            // the block in later turns — dropping it would make the recorded
            // output unusable as a replay input). Review finding, PR #39.
            blocks[event.index] = {
              type: "thinking",
              thinking: block.thinking ?? "",
              signature: block.signature ?? ""
            };
          } else if (block.type) {
            // Other block kinds (redacted_thinking arrives complete at
            // start; future API additions) are kept as-is rather than
            // dropped — deltas for them aren't understood, but the block's
            // existence is real data.
            blocks[event.index] = { ...block, type: block.type };
          }
          break;
        }
        case "content_block_delta": {
          if (event.index === undefined) break;
          const block = blocks[event.index];
          if (!block) break;
          if (event.delta?.type === "text_delta" && block.type === "text") {
            (block as { text: string }).text += event.delta.text ?? "";
          } else if (event.delta?.type === "input_json_delta" && block.type === "tool_use") {
            (block as { partialJson: string }).partialJson += event.delta.partial_json ?? "";
          } else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
            (block as { thinking: string }).thinking += event.delta.thinking ?? "";
          } else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
            (block as { signature: string }).signature = event.delta.signature ?? "";
          }
          break;
        }
        case "message_delta":
          if (event.usage?.output_tokens !== undefined) outputTokens = event.usage.output_tokens;
          if (event.usage?.input_tokens !== undefined) inputTokens = event.usage.input_tokens;
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          break;
      }
    },
    endOptions() {
      const content = blocks.filter(Boolean).map((block) => {
        if (block.type === "tool_use" && "partialJson" in block) {
          const { partialJson, ...rest } = block;
          const rawJson = typeof partialJson === "string" ? partialJson : "";
          let input: unknown;
          try {
            input = rawJson ? JSON.parse(rawJson) : {};
          } catch {
            // Truncated stream (early break mid-tool-call): keep the raw
            // fragment rather than losing it or throwing in a finalizer.
            input = { __partial_json: rawJson };
          }
          return { ...rest, input };
        }
        return block;
      });
      const usage = {
        ...(inputTokens !== undefined && { input_tokens: inputTokens }),
        ...(outputTokens !== undefined && { output_tokens: outputTokens })
      };
      return {
        output: {
          role: "assistant",
          ...(responseModel && { model: responseModel }),
          content,
          ...(stopReason && { stop_reason: stopReason })
        },
        ...(Object.keys(usage).length > 0 && { usageDetails: usage }),
        metadata: { streamed: "true" }
      };
    }
  };
}

/**
 * Wraps an Anthropic client instance so every messages.create() call —
 * streaming or not — is automatically recorded as a generation. Mutates
 * client.messages in place and returns the same client reference.
 *
 * Safe to call more than once on the same client — re-wrapping is detected
 * and is a no-op, rather than nesting a second wrapper around the first
 * (which would silently double-record every call).
 */
export function wrapAnthropic<T extends AnthropicLike>(
  client: T,
  ironside: IronsideClient,
  options: WrapAnthropicOptions = {}
): T {
  const messages = client.messages as MessagesLike & { __ironsideWrapped?: boolean };
  if (messages.__ironsideWrapped) return client;

  const originalCreate = messages.create.bind(messages) as (
    ...args: unknown[]
  ) => Promise<unknown>;

  const wrappedCreate = async (...args: unknown[]): Promise<unknown> => {
    const requestBody = args[0] as
      | (RequestModelParameters & { model?: string; messages?: unknown; stream?: boolean })
      | undefined;

    const modelParameters = extractModelParameters(requestBody);
    const trace = options.trace ?? ironside.trace({ name: "anthropic.messages.create" });
    const generation = trace.generation({
      name: "anthropic.messages.create",
      ...(requestBody?.model && { model: requestBody.model }),
      ...(modelParameters && { modelParameters }),
      input: requestBody?.messages
    });

    try {
      const result = await originalCreate(...args);

      if (requestBody?.stream) {
        const accumulator = createEventAccumulator();
        return instrumentAsyncIterable(result, accumulator.onEvent, ({ error, consumed }) => {
          if (error) generation.end(errorEndOptions(error));
          else if (consumed) generation.end(accumulator.endOptions());
          else generation.end({ metadata: { streamed: "true" } });
        });
      }

      const message = result as MessageLike;
      const usageDetails = usageDetailsFrom(message.usage);
      generation.end({
        output: message,
        ...(usageDetails && { usageDetails })
      });
      return result;
    } catch (error) {
      generation.end(errorEndOptions(error));
      throw error;
    }
  };
  messages.create = wrappedCreate as typeof messages.create;
  Object.defineProperty(messages, "__ironsideWrapped", { value: true, enumerable: false });

  return client;
}
