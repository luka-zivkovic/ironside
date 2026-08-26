import type { IronsideClient, TraceHandle } from "../client.js";

// The Vercel AI SDK (`ai` package, v7) already wraps whichever underlying
// provider you configure and has its own first-class OTel telemetry hook
// (`telemetry: {...}` on generateText/streamText, stable as of v7 —
// experimental_telemetry is now a deprecated alias). That's the more
// durable integration point for full OTel users (M3's /v1/otel/traces
// endpoint accepts it directly), so this module does NOT monkey-patch AI
// SDK internals the way wrapOpenAI/wrapAnthropic patch their respective
// clients. Instead it's a thin recorder: call recordGenerateTextResult()
// with the object generateText()/streamText() already returned.
//
// Verified against ai@7.0.22: LanguageModelUsage uses camelCase
// inputTokens/outputTokens — a third naming vocabulary, distinct from both
// OpenAI's (prompt_tokens/completion_tokens or input_tokens/output_tokens
// depending on endpoint) and Anthropic's (input_tokens/output_tokens).

export interface RecordGenerateTextOptions {
  trace?: TraceHandle;
  /** Passed through to the generation's name; defaults to "ai.generateText". */
  name?: string;
  /** The `model` id string you passed to generateText/streamText, since the result object doesn't always echo it back verbatim. */
  model?: string;
  /** The `prompt`/`messages` you passed in, for the recorded input. */
  input?: unknown;
  /** Sampling parameters (temperature, maxOutputTokens, ...) you passed to generateText/streamText — this recorder doesn't intercept the call, so these aren't available on the result and must be passed through explicitly. */
  modelParameters?: Record<string, string | number | boolean | null>;
}

interface LanguageModelUsageLike {
  inputTokens?: number;
  outputTokens?: number;
}

interface GenerateTextResultLike {
  text?: string;
  usage?: LanguageModelUsageLike;
}

/**
 * Records a completed generateText()/streamText() result as a generation.
 * Call after awaiting the result (or after a stream finishes and its
 * `usage` promise/property resolves) — this does not intercept the call
 * itself, since the AI SDK's own `telemetry` option is the recommended
 * hook for that.
 */
export function recordGenerateTextResult(
  ironside: IronsideClient,
  result: GenerateTextResultLike,
  options: RecordGenerateTextOptions = {}
): void {
  const trace = options.trace ?? ironside.trace({ name: options.name ?? "ai.generateText" });
  const generation = trace.generation({
    name: options.name ?? "ai.generateText",
    ...(options.model && { model: options.model }),
    ...(options.modelParameters && { modelParameters: options.modelParameters }),
    input: options.input
  });

  generation.end({
    output: result.text,
    ...(result.usage && {
      usageDetails: {
        ...(result.usage.inputTokens !== undefined && {
          input_tokens: result.usage.inputTokens
        }),
        ...(result.usage.outputTokens !== undefined && {
          output_tokens: result.usage.outputTokens
        })
      }
    })
  });
}
