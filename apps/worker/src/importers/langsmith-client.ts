import { z } from "zod";

// LangSmith POST /api/v1/runs/query — verified against the live OpenAPI
// spec at api.smith.langchain.com/openapi.json (not narrative docs), and
// the cursor field name (`cursors.next`) verified against the official
// langsmith SDK source (both JS and Python client implementations read
// this exact key — the OpenAPI schema itself only types `cursors` as a
// generic open string-keyed dict, so the key name isn't recoverable from
// the spec alone). Auth is X-API-Key (header name case-insensitive).
// GET /api/v1/feedback — LangSmith's score equivalent, verified against
// the same spec.
//
// Full-data import (M5-06): the trace-level backfill still queries
// is_root: true (root runs only) for pagination/checkpointing — proven
// resumable, and the natural unit for "one page = N traces". For each
// root run, a SEPARATE query with the `trace` filter (a real, spec-
// verified field on BodyParamsForRunsQuerySchema: "Filter runs by trace
// ID. When set, limit and cursor-based pagination are not applied — all
// runs in the trace are returned in a single response.") fetches every
// run in that trace's tree in one call — LangSmith needs no per-run
// detail endpoint the way LangFuse does, since runs/query already
// returns full run bodies (tokens, cost, status, parent_run_id) for
// every run, root or not.

// Full RunSchema fields (verified live against the OpenAPI spec) — costs
// are decimal STRINGS on the wire (not numbers), tokens are integers.
// run_type is one of tool/chain/llm/retriever/embedding/prompt/parser.
const langsmithRunSchema = z
  .object({
    id: z.string(),
    trace_id: z.string().optional(),
    parent_run_id: z.string().nullable().optional(),
    run_type: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    start_time: z.string(),
    end_time: z.string().nullable().optional(),
    first_token_time: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    inputs: z.unknown().optional(),
    outputs: z.unknown().optional(),
    extra: z.record(z.string(), z.unknown()).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    session_id: z.string().optional(),
    total_tokens: z.number().nullable().optional(),
    prompt_tokens: z.number().nullable().optional(),
    completion_tokens: z.number().nullable().optional(),
    // Decimal strings on the wire (e.g. "0.00123"); parsed to number by
    // the mapper, not here, so a malformed string fails loudly at the
    // mapping boundary rather than silently coercing via z.coerce.
    total_cost: z.string().nullable().optional(),
    prompt_cost: z.string().nullable().optional(),
    completion_cost: z.string().nullable().optional()
  })
  .passthrough();
export type LangsmithRun = z.infer<typeof langsmithRunSchema>;

const langsmithQueryResponseSchema = z.object({
  runs: z.array(langsmithRunSchema),
  cursors: z.record(z.string(), z.string().nullable()).nullable().optional()
});
export type LangsmithQueryResponse = z.infer<typeof langsmithQueryResponseSchema>;

// GET /api/v1/feedback response: a plain array (not the cursor-paginated
// shape runs/query uses), limit/offset pagination.
const langsmithFeedbackSchema = z
  .object({
    id: z.string(),
    run_id: z.string().nullable().optional(),
    trace_id: z.string().nullable().optional(),
    key: z.string(),
    score: z.number().nullable().optional(),
    value: z.unknown().optional(),
    comment: z.string().nullable().optional(),
    correction: z.unknown().optional(),
    created_at: z.string().nullable().optional(),
    feedback_source: z.record(z.string(), z.unknown()).nullable().optional()
  })
  .passthrough();
export type LangsmithFeedback = z.infer<typeof langsmithFeedbackSchema>;

export interface LangsmithClientConfig {
  baseUrl?: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class LangsmithApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "LangsmithApiError";
  }
}

export interface QueryRunsParams {
  sessionIds: string[];
  limit: number;
  /** Opaque cursor from a previous response's cursors.next; omit for the first page. */
  cursor?: string;
  /** ISO 8601; inclusive lower bound on run start_time. */
  startTime?: string;
}

const DEFAULT_BASE_URL = "https://api.smith.langchain.com";

export class LangsmithClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: LangsmithClientConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.config.apiKey,
      accept: "application/json",
      "content-type": "application/json"
    };
  }

  /** Oldest-first (order: "asc"), so a checkpoint on the last-seen cursor/start_time resumes correctly. Root runs only (is_root: true) — the trace-level pagination unit. */
  async queryRuns(params: QueryRunsParams): Promise<LangsmithQueryResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/runs/query`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        session: params.sessionIds,
        is_root: true,
        limit: params.limit,
        order: "asc",
        ...(params.cursor && { cursor: params.cursor }),
        ...(params.startTime && { start_time: params.startTime })
      })
    });
    if (!response.ok) {
      throw new LangsmithApiError(
        `LangSmith runs/query request failed: HTTP ${response.status}`,
        response.status
      );
    }
    return langsmithQueryResponseSchema.parse(await response.json());
  }

  /** Every run (root + all descendants) belonging to one trace, in a single unpaginated response — the `trace` filter's documented behavior. */
  async getTraceRuns(traceId: string): Promise<LangsmithRun[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/runs/query`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ trace: traceId })
    });
    if (!response.ok) {
      throw new LangsmithApiError(
        `LangSmith trace runs request failed for ${traceId}: HTTP ${response.status}`,
        response.status
      );
    }
    const parsed = langsmithQueryResponseSchema.parse(await response.json());
    return parsed.runs;
  }

  /**
   * Feedback (LangSmith's score equivalent) for a set of run ids. The
   * OpenAPI spec's `run` parameter is documented only as "uuid | uuid[]
   * | null" with no scope description (unlike the runs/query `trace`
   * filter, whose docstring explicitly says "all runs in the trace"),
   * so this is NOT assumed to filter by trace — callers must pass every
   * run id in the trace's tree (root + all descendants) to capture
   * feedback attached to any of them, not just the root run.
   *
   * `runIds` is chunked (not sent as one `run=`-per-id query string) so
   * a trace with hundreds of runs — plausible for agentic/looping
   * workflows — can't grow the URL unboundedly and risk a 414/proxy
   * truncation; each chunk still loops limit/offset pagination until a
   * short page signals that chunk's end.
   */
  async getFeedbackForRuns(runIds: string[]): Promise<LangsmithFeedback[]> {
    if (runIds.length === 0) return [];
    const RUN_IDS_PER_REQUEST = 50;
    const all: LangsmithFeedback[] = [];
    for (let i = 0; i < runIds.length; i += RUN_IDS_PER_REQUEST) {
      const chunk = runIds.slice(i, i + RUN_IDS_PER_REQUEST);
      all.push(...(await this.getFeedbackForRunChunk(chunk)));
    }
    return all;
  }

  private async getFeedbackForRunChunk(runIds: string[]): Promise<LangsmithFeedback[]> {
    const pageSize = 100;
    const all: LangsmithFeedback[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const url = new URL(`${this.baseUrl}/api/v1/feedback`);
      for (const runId of runIds) url.searchParams.append("run", runId);
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));
      const response = await this.fetchImpl(url, { headers: this.headers() });
      if (!response.ok) {
        throw new LangsmithApiError(
          `LangSmith feedback request failed: HTTP ${response.status}`,
          response.status
        );
      }
      const page = z.array(langsmithFeedbackSchema).parse(await response.json());
      all.push(...page);
      if (page.length < pageSize) break;
    }
    return all;
  }
}
