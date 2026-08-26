import { listIngestFailures, type IngestEventFailure } from "@ironside/db";
import {
  listIngestFailuresQuerySchema,
  type IngestFailureResponse,
  type ListIngestFailuresResponse
} from "@ironside/shared";
import { Hono } from "hono";
import type { Pool } from "pg";
import type { AuthEnv } from "../middleware/auth.js";

export interface IngestFailuresDeps {
  pool: Pool;
}

// Read-only view of the dead-letter store (M9-03): ingest events the
// worker could not map, previously visible only in worker logs. No
// delete/ack route — rows age out automatically via the retention
// sweep's fixed 30-day purge, and a diagnostics table shouldn't need
// manual grooming.
function toResponse(failure: IngestEventFailure): IngestFailureResponse {
  return {
    id: failure.id,
    projectId: failure.projectId,
    batchId: failure.batchId,
    objectKey: failure.objectKey,
    eventId: failure.eventId,
    source: failure.source,
    eventType: failure.eventType,
    error: failure.error,
    createdAt: failure.createdAt.toISOString()
  };
}

export function ingestFailuresRoutes(deps: IngestFailuresDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/ingest-failures", async (c) => {
    const parsed = listIngestFailuresQuerySchema.safeParse({ limit: c.req.query("limit") });
    if (!parsed.success) {
      return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
    }
    const failures = await listIngestFailures(deps.pool, c.get("projectId"), parsed.data.limit);
    const response: ListIngestFailuresResponse = { failures: failures.map(toResponse) };
    return c.json(response, 200);
  });

  return app;
}
