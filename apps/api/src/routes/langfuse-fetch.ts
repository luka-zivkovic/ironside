import type {
  ClickHouseClient,
  ObservationRow,
  ScoreRow,
  TraceDetailRow
} from "@ironside/clickhouse";
import { getTrace, listObservationsForTrace, listScoresForTrace, listTracePage } from "@ironside/clickhouse";
import { getProject } from "@ironside/db";
import { safeJsonParse } from "@ironside/mappers";
import { environmentNameSchema, traceSettledBefore } from "@ironside/shared";
import { Hono } from "hono";
import type { Pool } from "pg";
import { z } from "zod";
import type { AuthEnv } from "../middleware/auth.js";

// LangFuse-shaped READ endpoints (M8): GET /api/public/traces and
// GET /api/public/traces/{id}, matching LangFuse's own public API paths and
// response shapes so existing LangFuse consumers — coeval's poller, and
// Ironside's own LangFuse importer (a deliberate self-conformance target:
// pointing runLangfuseImport at an Ironside host must work) — read traces
// out of Ironside with zero code changes. The write-side counterparts
// (/public/ingestion, /public/scores) live in langfuse.ts; reads are
// mounted without rate limiting, matching the native query routes'
// convention (app.ts).
//
// Field-name fidelity notes (verified against LangFuse's Fern API
// definition and real-instance responses during M5):
// - observation `type`/`level` and score `dataType`/`source` are UPPERCASE
//   on LangFuse's wire (GENERATION/DEFAULT/NUMERIC/API); Ironside stores
//   lowercase, so responses upcase at this boundary.
// - list pagination is page/limit with a `meta` envelope
//   ({page, limit, totalItems, totalPages}), not Ironside's keyset cursor.
// - `orderBy` supports timestamp.asc/timestamp.desc (LangFuse's default is
//   newest-first); Ironside's own importer requests timestamp.asc.

export interface LangfuseFetchDeps {
  clickhouse: ClickHouseClient;
  pool: Pool;
  defaultTraceQuietPeriodSeconds: number;
}

async function settledBeforeForProject(
  deps: LangfuseFetchDeps,
  projectId: string
): Promise<string> {
  const project = await getProject(deps.pool, projectId);
  const quietPeriodSeconds =
    project?.traceQuietPeriodSeconds ?? deps.defaultTraceQuietPeriodSeconds;
  return traceSettledBefore(quietPeriodSeconds);
}

const listQuerySchema = z.object({
  // The max keeps offset = (page-1)*limit far inside Number.MAX_SAFE_INTEGER —
  // an absurd page would otherwise stringify to scientific notation and turn
  // a clean empty page into a ClickHouse parse error (500).
  page: z.coerce.number().int().min(1).max(1_000_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  environment: environmentNameSchema.optional(),
  fromTimestamp: z.iso.datetime({ offset: true }).optional(),
  toTimestamp: z.iso.datetime({ offset: true }).optional(),
  orderBy: z.enum(["timestamp.asc", "timestamp.desc"]).default("timestamp.desc")
});

// Optional fields that are unset OMIT the key rather than emitting an
// explicit null. Found empirically on first live contact with coeval (the
// M8 consumer): its LangFuse trace schema types optional fields as
// z.string().optional() — absent is fine, an explicit null fails
// validation and the whole poll errors out. Omission is the compatible
// intersection: optional-tolerant consumers (coeval, Ironside's own
// importer whose schema is .nullable().optional()) all accept it.
function traceItem(row: TraceDetailRow) {
  const input = safeJsonParse(row.input);
  const output = safeJsonParse(row.output);
  return {
    id: row.id,
    timestamp: row.timestamp,
    tags: row.tags,
    metadata: row.metadata,
    ...(row.name !== null && { name: row.name }),
    ...(row.user_id !== null && { userId: row.user_id }),
    ...(row.session_id !== null && { sessionId: row.session_id }),
    ...(row.environment !== null && { environment: row.environment }),
    ...(row.release !== null && { release: row.release }),
    ...(row.version !== null && { version: row.version }),
    // input/output: a stored SQL NULL means "never recorded" (omit); the
    // JSON text "null" parses to a real null, which safeJsonParse returns
    // and which IS emitted — explicitly-recorded null survives.
    ...(row.input !== null && { input }),
    ...(row.output !== null && { output })
  };
}

function observationItem(row: ObservationRow) {
  return {
    id: row.id,
    traceId: row.trace_id,
    type: row.type.toUpperCase(),
    startTime: row.start_time,
    level: row.level.toUpperCase(),
    modelParameters: row.model_parameters,
    usageDetails: row.usage_details,
    costDetails: row.cost_details,
    metadata: row.metadata,
    ...(row.parent_observation_id !== null && { parentObservationId: row.parent_observation_id }),
    ...(row.name !== null && { name: row.name }),
    ...(row.end_time !== null && { endTime: row.end_time }),
    ...(row.completion_start_time !== null && { completionStartTime: row.completion_start_time }),
    ...(row.status_message !== null && { statusMessage: row.status_message }),
    ...(row.model !== null && { model: row.model }),
    ...(row.input !== null && { input: safeJsonParse(row.input) }),
    ...(row.output !== null && { output: safeJsonParse(row.output) })
  };
}

function scoreItem(row: ScoreRow) {
  return {
    id: row.id,
    traceId: row.trace_id,
    name: row.name,
    dataType: row.data_type.toUpperCase(),
    source: row.source.toUpperCase(),
    timestamp: row.timestamp,
    metadata: row.metadata,
    ...(row.observation_id !== null && { observationId: row.observation_id }),
    ...(row.value !== null && { value: row.value }),
    ...(row.string_value !== null && { stringValue: row.string_value }),
    ...(row.comment !== null && { comment: row.comment })
  };
}

export function langfuseFetchRoutes(deps: LangfuseFetchDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/public/traces", async (c) => {
    const parsed = listQuerySchema.safeParse({
      page: c.req.query("page"),
      limit: c.req.query("limit"),
      userId: c.req.query("userId"),
      sessionId: c.req.query("sessionId"),
      environment: c.req.query("environment"),
      fromTimestamp: c.req.query("fromTimestamp"),
      toTimestamp: c.req.query("toTimestamp"),
      orderBy: c.req.query("orderBy")
    });
    if (!parsed.success) {
      return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
    }
    const q = parsed.data;
    const projectId = c.get("projectId");
    const settledBefore = await settledBeforeForProject(deps, projectId);

    const { rows, totalItems } = await listTracePage(deps.clickhouse, {
      projectId,
      page: q.page,
      limit: q.limit,
      order: q.orderBy === "timestamp.asc" ? "asc" : "desc",
      settledBefore,
      ...(q.userId && { userId: q.userId }),
      ...(q.sessionId && { sessionId: q.sessionId }),
      ...(q.environment && { environment: q.environment }),
      ...(q.fromTimestamp && { from: q.fromTimestamp }),
      ...(q.toTimestamp && { to: q.toTimestamp })
    });

    return c.json(
      {
        data: rows.map(traceItem),
        meta: {
          page: q.page,
          limit: q.limit,
          totalItems,
          totalPages: Math.ceil(totalItems / q.limit)
        }
      },
      200
    );
  });

  app.get("/public/traces/:id", async (c) => {
    const projectId = c.get("projectId");
    const traceId = c.req.param("id");
    const settledBefore = await settledBeforeForProject(deps, projectId);

    const [trace, observations, scores] = await Promise.all([
      getTrace(deps.clickhouse, projectId, traceId, settledBefore),
      listObservationsForTrace(deps.clickhouse, projectId, traceId),
      listScoresForTrace(deps.clickhouse, projectId, traceId)
    ]);
    if (!trace) {
      return c.json({ error: "trace not found" }, 404);
    }

    return c.json(
      {
        ...traceItem(trace),
        observations: observations.map(observationItem),
        scores: scores.map(scoreItem)
      },
      200
    );
  });

  return app;
}
