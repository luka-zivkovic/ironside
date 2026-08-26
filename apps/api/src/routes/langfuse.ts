import { createHash } from "node:crypto";
import type { IngestBatch, IngestEvent, QueueMessage } from "@ironside/shared";
import {
  INGEST_SCHEMA_VERSION,
  langfuseIngestionRequestSchema,
  type LangfuseIngestionResponse
} from "@ironside/shared";
import type { ObjectStorage } from "@ironside/storage";
import type { Queue } from "bullmq";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { persistAndEnqueueIngestBatch } from "../lib/persist-ingest-batch.js";
import type { AuthEnv } from "../middleware/auth.js";

export interface LangfuseDeps {
  storage: ObjectStorage;
  queue: Queue<QueueMessage>;
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

/**
 * POST /api/public/ingestion — LangFuse's own endpoint URL, so a client
 * setting LANGFUSE_BASEURL to this host and keeping its existing
 * LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY genuinely works with zero code
 * changes (targets the legacy `langfuse` npm package specifically — see
 * spec/langfuse-compat-v1.md for why the current v4+/v5 SDK generation
 * isn't this endpoint's concern, it uses OTLP instead).
 *
 * Same fast-ACK design as the native/OTLP ingest routes: validate the
 * envelope, persist the whole batch as one "langfuse-ingestion" event,
 * queue a reference. The 207 response always returns success/error per
 * batch item, matching LangFuse's own endpoint, so the SDK's response
 * handling (which expects 207) doesn't choke on this compat layer.
 */
export function langfuseRoutes(deps: LangfuseDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post("/public/ingestion", async (c) => {
    const rawBody: unknown = await c.req.json().catch(() => null);
    const parsed = langfuseIngestionRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      // LangFuse's real endpoint returns 207 even for malformed requests
      // when at all possible; a request that fails basic envelope
      // validation (not even a valid {batch: [...]} shape) has no
      // per-event ids to attach errors to, so this one case falls back to
      // a plain 400 — every individual batch item beyond this point
      // is reported via the 207 body instead.
      return c.json({ error: "invalid LangFuse ingestion payload", issues: parsed.error.issues }, 400);
    }

    const projectId = c.get("projectId");
    const batchId = ulid();
    const receivedAt = new Date();

    const event: IngestEvent = {
      id: ulid(),
      type: "langfuse-ingestion",
      source: "langfuse",
      schemaVersion: INGEST_SCHEMA_VERSION,
      idempotencyKey: contentHash(parsed.data),
      body: parsed.data
    };

    const batch: IngestBatch = {
      batchId,
      projectId,
      receivedAt: receivedAt.toISOString(),
      events: [event]
    };

    await persistAndEnqueueIngestBatch(deps, batch);

    // The real endpoint's 207 reflects actual per-event validation
    // outcomes computed synchronously; this compat layer processes the
    // batch asynchronously (same async pipeline as every other ingest
    // path), so it optimistically reports every event as accepted here —
    // envelope-level validation already passed above, and event-level
    // mapping errors (if any) only surface in worker logs, not this
    // response. Matches LangFuse's status-code contract even though the
    // error-reporting granularity is coarser.
    const response: LangfuseIngestionResponse = {
      successes: parsed.data.batch.map((e) => ({ id: e.id, status: 201 })),
      errors: []
    };
    return c.json(response, 207);
  });

  // POST /api/public/scores — LangFuse's score-create endpoint, the write
  // half of the M8 coeval integration: coeval's feedback-sync worker posts
  // judge verdicts here ({id, traceId, name: "coeval_verdict", value,
  // comment, metadata}) exactly as it would to a real LangFuse host.
  // Reuses the native score-upsert envelope path — the route translates
  // LangFuse's score body into a domain-shaped score-upsert event, and the
  // existing worker native mapper inserts it; no worker changes needed.
  // Replays with the same id are harmless upserts (ReplacingMergeTree
  // dedups on id), so there's no 409-on-duplicate: callers like coeval
  // treat any 2xx as success and their idempotency ids simply converge.
  app.post("/public/scores", async (c) => {
    const parsed = langfuseCreateScoreSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid score payload", issues: parsed.error.issues }, 400);
    }
    const score = parsed.data;
    const projectId = c.get("projectId");
    const batchId = ulid();
    const receivedAt = new Date();
    const scoreId = score.id ?? ulid();

    const isNumeric = typeof score.value === "number";
    // LangFuse's BOOLEAN scores carry a numeric 0/1 value; honor a declared
    // boolean dataType only when the value is actually numeric, otherwise
    // infer from the value's type.
    const dataType =
      isNumeric && score.dataType?.toUpperCase() === "BOOLEAN"
        ? "boolean"
        : isNumeric
          ? "numeric"
          : "categorical";

    const body = {
      id: scoreId,
      traceId: score.traceId,
      ...(score.observationId && { observationId: score.observationId }),
      name: score.name,
      dataType,
      source: "api",
      ...(isNumeric ? { value: score.value } : { stringValue: String(score.value) }),
      ...(score.comment && { comment: score.comment }),
      timestamp: receivedAt.toISOString(),
      metadata: stringifyMetadata(score.metadata)
    };

    const event: IngestEvent = {
      id: ulid(),
      type: "score-upsert",
      source: "native",
      schemaVersion: INGEST_SCHEMA_VERSION,
      idempotencyKey: contentHash(body),
      body
    };

    const batch: IngestBatch = {
      batchId,
      projectId,
      receivedAt: receivedAt.toISOString(),
      events: [event]
    };

    await persistAndEnqueueIngestBatch(deps, batch);

    return c.json({ id: scoreId }, 200);
  });

  return app;
}

// LangFuse's score-create body: value may be a number (numeric/boolean
// scores) or a string (categorical). Everything beyond what Ironside can
// store is accepted-and-ignored via the schema's lenient extras below,
// matching the compat layer's general posture (LangFuse clients shouldn't
// 400 on fields Ironside doesn't model).
const langfuseCreateScoreSchema = z.object({
  id: z.string().min(1).optional(),
  traceId: z.string().min(1),
  observationId: z.string().min(1).nullable().optional(),
  name: z.string().min(1),
  value: z.union([z.number(), z.string().min(1)]),
  comment: z.string().nullable().optional(),
  dataType: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional()
});

/** Domain metadata is Record<string, string> — stringify non-string values, same convention as every mapper. */
function stringifyMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, string> {
  if (!metadata) return {};
  return Object.fromEntries(
    Object.entries(metadata).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
  );
}
