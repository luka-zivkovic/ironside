export { init } from "./client.js";
export type {
  IronsideClient,
  IronsideClientOptions,
  TraceHandle,
  ObservationHandle,
  UploadMediaOptions,
  UploadedMedia
} from "./client.js";
export type {
  StartTraceOptions,
  UpdateTraceOptions,
  StartSpanOptions,
  StartGenerationOptions,
  EndObservationOptions,
  ScoreOptions
} from "./types.js";

export { wrapOpenAI } from "./wrappers/openai.js";
export type { WrapOpenAIOptions } from "./wrappers/openai.js";
export { wrapAnthropic } from "./wrappers/anthropic.js";
export type { WrapAnthropicOptions } from "./wrappers/anthropic.js";
export { recordGenerateTextResult } from "./wrappers/vercel-ai.js";
export type { RecordGenerateTextOptions } from "./wrappers/vercel-ai.js";
