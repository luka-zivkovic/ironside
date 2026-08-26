// Wire-contract types, deliberately duplicated from (not imported from)
// @ironside/shared: this package ships standalone to npm and cannot depend
// on a private workspace package. Kept intentionally minimal — only the
// fields the SDK itself constructs.

export interface StartTraceOptions {
  id?: string;
  name?: string;
  userId?: string;
  sessionId?: string;
  environment?: string;
  release?: string;
  version?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  input?: unknown;
}

export interface UpdateTraceOptions {
  output?: unknown;
  metadata?: Record<string, string>;
}

interface ScoreOptionsBase {
  id?: string;
  /** Attaches the score to a specific observation instead of the trace as a whole. */
  observationId?: string;
  name: string;
  source?: "api" | "eval" | "annotation";
  comment?: string;
  metadata?: Record<string, string>;
}

/**
 * Exactly one of value/stringValue — enforced at the type level (not just
 * documented) so a caller can't produce a score with neither (dropped
 * server-side against the domain schema's invariant, silently, since the
 * SDK's ingest is fire-and-forget) or both (an internally inconsistent
 * dataType/payload pairing).
 */
export type ScoreOptions =
  | (ScoreOptionsBase & { value: number; stringValue?: undefined })
  | (ScoreOptionsBase & { stringValue: string; value?: undefined });

export interface StartSpanOptions {
  id?: string;
  name?: string;
  input?: unknown;
  metadata?: Record<string, string>;
}

export interface StartGenerationOptions extends StartSpanOptions {
  model?: string;
  modelParameters?: Record<string, string | number | boolean | null>;
}

export interface EndObservationOptions {
  output?: unknown;
  statusMessage?: string;
  level?: "debug" | "default" | "warning" | "error";
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  metadata?: Record<string, string>;
}

export type IngestEventType =
  | "trace-upsert"
  | "observation-upsert"
  | "score-upsert";

export interface IngestRequestEvent {
  id?: string;
  type: IngestEventType;
  body: unknown;
}
