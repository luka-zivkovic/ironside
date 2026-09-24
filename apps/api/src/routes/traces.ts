import {
  getAggregates,
  getTrace,
  listObservationsForTrace,
  listTraceMetrics,
  listTraces
} from "@ironside/clickhouse";
import type { ClickHouseClient, TraceFilter } from "@ironside/clickhouse";
import {
  aggregatesQuerySchema,
  listTracesQuerySchema,
  type AggregatesQuery,
  type AggregatesResponse,
  type ListTracesResponse,
  type TraceTreeResponse
} from "@ironside/shared";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { buildObservationTree, safeJsonParse } from "@ironside/mappers";

export interface TracesDeps {
  clickhouse: ClickHouseClient;
}

/** The filter both the list and its aggregates apply, so the summary always describes the listed traces. */
function traceFilter(projectId: string, query: AggregatesQuery): TraceFilter {
  return {
    projectId,
    ...(query.from !== undefined && { from: query.from }),
    ...(query.to !== undefined && { to: query.to }),
    ...(query.userId !== undefined && { userId: query.userId }),
    ...(query.sessionId !== undefined && { sessionId: query.sessionId }),
    ...(query.environment !== undefined && { environment: query.environment }),
    ...(query.tags !== undefined && { tags: query.tags }),
    ...(query.metadataKey !== undefined && { metadataKey: query.metadataKey }),
    ...(query.metadataValue !== undefined && { metadataValue: query.metadataValue }),
    ...(query.search && { search: query.search }),
    ...(query.level !== undefined && { level: query.level }),
    ...(query.model && { model: query.model }),
    ...(query.minDurationMs !== undefined && { minDurationMs: query.minDurationMs }),
    ...(query.minCost !== undefined && { minCost: query.minCost })
  };
}

export function tracesRoutes(deps: TracesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/traces", async (c) => {
    const parsed = listTracesQuerySchema.safeParse({
      ...c.req.query(),
      tags: c.req.queries("tags")
    });
    if (!parsed.success) {
      return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
    }

    const query = parsed.data;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (query.cursor && !cursor) {
      return c.json({ error: "invalid cursor" }, 400);
    }

    const projectId = c.get("projectId");
    const rows = await listTraces(deps.clickhouse, {
      ...traceFilter(projectId, query),
      // Fetch one extra row to know whether a next page exists.
      limit: query.limit + 1,
      ...(cursor && { cursor })
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);
    const metrics = await listTraceMetrics(
      deps.clickhouse,
      projectId,
      page.map((row) => row.id)
    );

    const response: ListTracesResponse = {
      traces: page.map((row) => {
        const figures = metrics.get(row.id);
        return {
          id: row.id,
          timestamp: row.timestamp,
          name: row.name,
          userId: row.user_id,
          sessionId: row.session_id,
          environment: row.environment,
          tags: row.tags,
          metadata: row.metadata,
          durationMs: figures?.duration_ms ?? null,
          totalCost: figures?.total_cost ?? null,
          totalTokens: figures?.total_tokens ?? null,
          errorCount: figures?.error_count ?? 0,
          models: figures?.models ?? []
        };
      }),
      nextCursor:
        hasMore && last ? encodeCursor({ timestamp: last.timestamp, id: last.id }) : null
    };

    return c.json(response, 200);
  });

  // Must be registered before /traces/:id — otherwise Hono matches
  // "aggregates" as the :id param and this route is unreachable.
  app.get("/traces/aggregates", async (c) => {
    const parsed = aggregatesQuerySchema.safeParse({
      ...c.req.query(),
      tags: c.req.queries("tags")
    });
    if (!parsed.success) {
      return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
    }
    const query = parsed.data;

    const result = await getAggregates(deps.clickhouse, traceFilter(c.get("projectId"), query));

    const response: AggregatesResponse = {
      traceCount: result.trace_count,
      tokenTotals: result.token_totals,
      costTotals: result.cost_totals,
      latencyMsPercentiles: {
        p50: result.latency_p50,
        p95: result.latency_p95,
        p99: result.latency_p99
      }
    };

    return c.json(response, 200);
  });

  app.get("/traces/:id", async (c) => {
    const projectId = c.get("projectId");
    const traceId = c.req.param("id");

    const [trace, observationRows] = await Promise.all([
      getTrace(deps.clickhouse, projectId, traceId),
      listObservationsForTrace(deps.clickhouse, projectId, traceId)
    ]);
    if (!trace) {
      return c.json({ error: "trace not found" }, 404);
    }

    const response: TraceTreeResponse = {
      id: trace.id,
      timestamp: trace.timestamp,
      name: trace.name,
      userId: trace.user_id,
      sessionId: trace.session_id,
      environment: trace.environment,
      release: trace.release,
      version: trace.version,
      tags: trace.tags,
      metadata: trace.metadata,
      input: safeJsonParse(trace.input),
      output: safeJsonParse(trace.output),
      observations: buildObservationTree(observationRows)
    };

    return c.json(response, 200);
  });

  return app;
}
