import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { IngestBatch, IngestEvent, QueueMessage } from "@ironside/shared";
import {
  INGEST_SCHEMA_VERSION,
  otlpExportTraceServiceRequestSchema
} from "@ironside/shared";
import type { ObjectStorage } from "@ironside/storage";
import type { Queue } from "bullmq";
import { Hono } from "hono";
import { ulid } from "ulid";
import { MAX_REQUEST_BODY_BYTES } from "../app.js";
import { persistAndEnqueueIngestBatch } from "../lib/persist-ingest-batch.js";
import type { AuthEnv } from "../middleware/auth.js";
import {
  decodeExportTraceServiceRequest,
  encodeEmptyExportTraceServiceResponse
} from "../otlp-proto.js";

export interface OtlpDeps {
  storage: ObjectStorage;
  queue: Queue<QueueMessage>;
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

/**
 * POST /v1/otel/traces — OTLP/HTTP trace ingest, both wire encodings
 * (application/x-protobuf and application/json). Same fast-ACK design as
 * /api/v1/ingest: validate the envelope, persist the raw
 * ExportTraceServiceRequest as a single "otlp-export" event, queue a
 * reference. The worker's OTLP mapper (not this route) explodes it into
 * trace/observation rows — one export can span many traces.
 *
 * A protobuf body is decoded into the OTLP/JSON object shape first
 * (src/otlp-proto.ts), so validation, the stored raw envelope, and the
 * worker are one shared path — the raw log stays JSON regardless of wire
 * encoding, and the same export hashes to the same idempotency key either
 * way. gzip content-encoding is accepted for both (the OTel Collector's
 * otlphttp exporter compresses by default).
 *
 * Per the OTLP/HTTP spec, a success response uses the request's
 * content-type: protobuf-in gets a serialized (empty = fully accepted)
 * ExportTraceServiceResponse back. Error responses are JSON regardless —
 * the spec prefers a google.rpc.Status in the request encoding, but
 * exporters only log error bodies, and a readable JSON error beats an
 * opaque binary one (deviation documented in spec/otlp-ingest-v1.md).
 */
export function otlpRoutes(deps: OtlpDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post("/otel/traces", async (c) => {
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    const isProtobuf = contentType.includes("application/x-protobuf");
    const isJson = contentType.includes("application/json");
    if (!isProtobuf && !isJson) {
      return c.json(
        { error: "unsupported content-type: expected application/x-protobuf or application/json" },
        415
      );
    }

    const encoding = (c.req.header("content-encoding") ?? "").toLowerCase().trim();
    if (encoding && encoding !== "identity" && encoding !== "gzip") {
      return c.json(
        { error: `unsupported content-encoding "${encoding}": only gzip (or none) is accepted` },
        415
      );
    }

    let body = Buffer.from(await c.req.arrayBuffer());
    if (encoding === "gzip") {
      try {
        // maxOutputLength caps the DECOMPRESSED size. The app-level
        // bodyLimit only bounds wire bytes, and gzip reaches ~1000:1 on
        // repetitive input — without this cap a ~200KB compressed body
        // could expand to 200MB in one synchronous allocation.
        body = gunzipSync(body, { maxOutputLength: MAX_REQUEST_BODY_BYTES });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
          return c.json({ error: "decompressed request body too large" }, 413);
        }
        return c.json({ error: "content-encoding is gzip but the body is not valid gzip" }, 400);
      }
    }

    let rawBody: unknown;
    if (isProtobuf) {
      try {
        rawBody = decodeExportTraceServiceRequest(body);
      } catch {
        return c.json({ error: "invalid protobuf: body is not a decodable ExportTraceServiceRequest" }, 400);
      }
    } else {
      try {
        rawBody = JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        rawBody = null;
      }
    }

    const parsed = otlpExportTraceServiceRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "invalid OTLP export request", issues: parsed.error.issues },
        400
      );
    }

    const projectId = c.get("projectId");
    const batchId = ulid();
    const receivedAt = new Date();

    const event: IngestEvent = {
      id: ulid(),
      type: "otlp-export",
      source: "otlp",
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

    // OTLP/HTTP spec: a successful export returns an
    // ExportTraceServiceResponse in the request's content-type. Empty
    // message (JSON: {}) = fully accepted, no partial_success.
    if (isProtobuf) {
      return c.body(Buffer.from(encodeEmptyExportTraceServiceResponse()), 200, {
        "Content-Type": "application/x-protobuf"
      });
    }
    return c.json({}, 200);
  });

  return app;
}
