import { createHash } from "node:crypto";
import type { ObjectStorage } from "@ironside/storage";
import type { QueueMessage, IngestBatch, IngestEvent } from "@ironside/shared";
import {
  INGEST_SCHEMA_VERSION,
  ingestRequestSchema
} from "@ironside/shared";
import type { Queue } from "bullmq";
import { Hono } from "hono";
import { ulid } from "ulid";
import { persistAndEnqueueIngestBatch } from "../lib/persist-ingest-batch.js";
import type { AuthEnv } from "../middleware/auth.js";

export interface IngestDeps {
  storage: ObjectStorage;
  queue: Queue<QueueMessage>;
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

/**
 * POST /api/v1/ingest — the fast-ACK edge of the pipeline. Validates the
 * envelope only, persists the raw batch to object storage, queues a
 * reference, and returns. No ClickHouse work happens here.
 */
export function ingestRoutes(deps: IngestDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post("/ingest", async (c) => {
    const parsed = ingestRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: "invalid ingest payload", issues: parsed.error.issues },
        400
      );
    }

    const projectId = c.get("projectId");
    const batchId = ulid();
    const receivedAt = new Date();

    const events: IngestEvent[] = parsed.data.events.map((event) => ({
      id: event.id ?? ulid(),
      type: event.type,
      source: "native",
      schemaVersion: INGEST_SCHEMA_VERSION,
      idempotencyKey: event.idempotencyKey ?? contentHash(event.body),
      body: event.body
    }));

    const batch: IngestBatch = {
      batchId,
      projectId,
      receivedAt: receivedAt.toISOString(),
      events
    };

    await persistAndEnqueueIngestBatch(deps, batch);

    return c.json({ batchId, received: events.length }, 202);
  });

  return app;
}
