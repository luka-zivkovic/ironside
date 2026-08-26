import { z } from "zod";

// LangFuse GET /api/public/traces (their public read API) — verified
// against their Fern API definition (github.com/langfuse/langfuse
// fern/apis/server/definition/trace.yml, commons.yml, utils/pagination.yml),
// not narrative docs. Page/limit pagination (no cursor token); orderBy +
// fromTimestamp/toTimestamp support a resumable, oldest-first backfill.

const langfuseListTraceSchema = z
  .object({
    id: z.string(),
    timestamp: z.string(),
    name: z.string().nullable().optional(),
    userId: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    metadata: z.unknown().optional(),
    tags: z.array(z.string()).optional(),
    release: z.string().nullable().optional(),
    version: z.string().nullable().optional()
  })
  .passthrough();
export type LangfuseListTrace = z.infer<typeof langfuseListTraceSchema>;

// GET /api/public/traces/{id} — the full trace: everything the list
// endpoint has, PLUS observations[] and scores[]. Verified against a real
// LangFuse instance's responses (not just the Fern definition): observation
// `type` is uppercase (GENERATION/SPAN/EVENT), `level` uppercase
// (DEFAULT/DEBUG/WARNING/ERROR), usage comes both as modern `usageDetails`
// (open record) and legacy `usage {input,output,total,unit}`, cost as
// `costDetails` plus legacy calculated*Cost fields.
const langfuseObservationSchema = z
  .object({
    id: z.string(),
    traceId: z.string().nullable().optional(),
    parentObservationId: z.string().nullable().optional(),
    type: z.string(),
    name: z.string().nullable().optional(),
    startTime: z.string(),
    endTime: z.string().nullable().optional(),
    completionStartTime: z.string().nullable().optional(),
    level: z.string().nullable().optional(),
    statusMessage: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    modelParameters: z.record(z.string(), z.unknown()).nullable().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    usageDetails: z.record(z.string(), z.number()).nullable().optional(),
    costDetails: z.record(z.string(), z.number()).nullable().optional(),
    calculatedInputCost: z.number().nullable().optional(),
    calculatedOutputCost: z.number().nullable().optional(),
    calculatedTotalCost: z.number().nullable().optional(),
    metadata: z.unknown().optional(),
    promptName: z.string().nullable().optional(),
    promptVersion: z.number().nullable().optional()
  })
  .passthrough();
export type LangfuseObservation = z.infer<typeof langfuseObservationSchema>;

const langfuseScoreSchema = z
  .object({
    id: z.string(),
    traceId: z.string(),
    observationId: z.string().nullable().optional(),
    name: z.string(),
    value: z.number().nullable().optional(),
    stringValue: z.string().nullable().optional(),
    dataType: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    comment: z.string().nullable().optional(),
    timestamp: z.string().nullable().optional(),
    metadata: z.unknown().optional()
  })
  .passthrough();
export type LangfuseScore = z.infer<typeof langfuseScoreSchema>;

const langfuseTraceDetailSchema = langfuseListTraceSchema.extend({
  environment: z.string().nullable().optional(),
  observations: z.array(langfuseObservationSchema).default([]),
  scores: z.array(langfuseScoreSchema).default([])
});
export type LangfuseTraceDetail = z.infer<typeof langfuseTraceDetailSchema>;

const langfuseTracesResponseSchema = z.object({
  data: z.array(langfuseListTraceSchema),
  meta: z.object({
    page: z.number(),
    limit: z.number(),
    totalItems: z.number(),
    totalPages: z.number()
  })
});
export type LangfuseTracesResponse = z.infer<typeof langfuseTracesResponseSchema>;

export interface LangfuseClientConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
}

export class LangfuseApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "LangfuseApiError";
  }
}

export interface ListTracesParams {
  page: number;
  limit: number;
  /** ISO 8601; inclusive lower bound on trace.timestamp. */
  fromTimestamp?: string;
}

export class LangfuseClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: LangfuseClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private authHeader(): string {
    const credentials = Buffer.from(`${this.config.publicKey}:${this.config.secretKey}`).toString(
      "base64"
    );
    return `Basic ${credentials}`;
  }

  /** Oldest-first (orderBy=timestamp.asc), so a checkpoint on the last-seen timestamp resumes correctly. */
  async listTraces(params: ListTracesParams): Promise<LangfuseTracesResponse> {
    const url = new URL(`${this.baseUrl}/api/public/traces`);
    url.searchParams.set("page", String(params.page));
    url.searchParams.set("limit", String(params.limit));
    url.searchParams.set("orderBy", "timestamp.asc");
    if (params.fromTimestamp) url.searchParams.set("fromTimestamp", params.fromTimestamp);

    const response = await this.fetchImpl(url, {
      headers: { authorization: this.authHeader(), accept: "application/json" }
    });
    if (!response.ok) {
      throw new LangfuseApiError(
        `LangFuse traces request failed: HTTP ${response.status}`,
        response.status
      );
    }
    return langfuseTracesResponseSchema.parse(await response.json());
  }

  /** The full trace: list fields plus observations[] and scores[]. */
  async getTraceDetail(traceId: string): Promise<LangfuseTraceDetail> {
    const url = new URL(`${this.baseUrl}/api/public/traces/${encodeURIComponent(traceId)}`);
    const response = await this.fetchImpl(url, {
      headers: { authorization: this.authHeader(), accept: "application/json" }
    });
    if (!response.ok) {
      throw new LangfuseApiError(
        `LangFuse trace detail request failed for ${traceId}: HTTP ${response.status}`,
        response.status
      );
    }
    return langfuseTraceDetailSchema.parse(await response.json());
  }
}
