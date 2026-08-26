import { createHash } from "node:crypto";
import { createMediaAsset, getMediaAsset, getMediaAssetBySha } from "@ironside/db";
import type { ObjectStorage } from "@ironside/storage";
import { Hono } from "hono";
import type { Pool } from "pg";
import { ulid } from "ulid";
import type { AuthEnv } from "../middleware/auth.js";

export interface MediaDeps {
  pool: Pool;
  storage: ObjectStorage;
}

// Media assets (M9-09). input/output live as JSON text in ClickHouse —
// base64-embedding an image there would bloat the columnar store and every
// query touching the column. Instead: blobs go straight to object storage
// (content-addressed per project, so identical bytes dedupe to one object),
// a small Postgres row records ownership + content type, and the trace
// JSON carries only a compact ref string:
//
//   ironside://media/<id>
//
// The SDK's uploadMedia() returns that ref; the web viewer resolves any
// ref it finds inside input/output through the owner-session project route.
// Deliberately NOT part of the ingest event pipeline: media is immutable,
// has no per-event semantics, and replaying raw batches must not require
// re-uploading blobs.
//
// Size is bounded by the app-level bodyLimit (10MB) — same ceiling as any
// ingest body. Retention: media is NOT yet covered by the retention sweep
// (tracked in ROADMAP; the raw event log has the same gap).

export const MEDIA_REF_PREFIX = "ironside://media/";

export function mediaUploadRoutes(deps: MediaDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post("/media", async (c) => {
    const contentType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!contentType || contentType === "application/x-www-form-urlencoded" || contentType === "multipart/form-data") {
      return c.json(
        { error: "send the raw bytes with their real content-type header (e.g. image/png) — multipart/form-encoding is not accepted" },
        415
      );
    }

    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) {
      return c.json({ error: "empty body" }, 400);
    }

    const projectId = c.get("projectId");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const objectKey = `media/${projectId}/${sha256}`;

    // Dedup check BEFORE touching storage: assets are first-write-wins
    // immutable. Without this, re-uploading the same bytes with a
    // different content-type would silently rewrite the stored object's
    // ContentType metadata while the row kept the original — a
    // row/object inconsistency waiting to bite anything that reads the
    // object directly (review finding, PR #41).
    const existing = await getMediaAssetBySha(deps.pool, projectId, sha256);
    if (existing) {
      return c.json(
        {
          id: existing.id,
          ref: `${MEDIA_REF_PREFIX}${existing.id}`,
          contentType: existing.contentType,
          sizeBytes: existing.sizeBytes,
          sha256: existing.sha256
        },
        201
      );
    }

    // Object write first, row second: a row without its object would 500
    // forever on GET; an object without a row is only an orphaned blob a
    // retried upload reuses (same content address).
    await deps.storage.putBytes(objectKey, body, contentType);
    const asset = await createMediaAsset(deps.pool, {
      id: ulid(),
      projectId,
      sha256,
      contentType,
      sizeBytes: body.byteLength,
      objectKey
    });

    return c.json(
      {
        id: asset.id,
        ref: `${MEDIA_REF_PREFIX}${asset.id}`,
        contentType: asset.contentType,
        sizeBytes: asset.sizeBytes,
        sha256: asset.sha256
      },
      201
    );
  });

  return app;
}

export function mediaReadRoutes(deps: MediaDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/media/:id", async (c) => {
    const projectId = c.get("projectId");
    const asset = await getMediaAsset(deps.pool, projectId, c.req.param("id"));
    if (!asset) {
      return c.json({ error: "media not found" }, 404);
    }
    const { body } = await deps.storage.getBytes(asset.objectKey);
    // Re-wrap: hono's Data type requires Uint8Array<ArrayBuffer>, and the
    // SDK's transformToByteArray types its buffer as ArrayBufferLike.
    //
    // Hardening headers: this endpoint serves caller-supplied bytes with a
    // caller-supplied content type from the API origin. The browser fetches
    // this route as a Blob rather than embedding it directly; nosniff, a
    // no-script CSP, and non-inline disposition
    // for non-image types keep it unreachable even if a future code path
    // (presigned URLs, a raw link in the UI) exposes the response to
    // direct browser navigation. Deliberately NOT an upload allowlist:
    // Ironside stores what it's given (an LLM app's html/svg artifact is
    // legitimate data); the serving path is where execution is denied.
    const isImage = asset.contentType.startsWith("image/") && asset.contentType !== "image/svg+xml";
    return c.body(new Uint8Array(body), 200, {
      "Content-Type": asset.contentType,
      "Content-Length": String(asset.sizeBytes),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `${isImage ? "inline" : "attachment"}; filename="${asset.id}"`,
      // Content-addressed and immutable — safe to cache aggressively.
      "Cache-Control": "private, max-age=31536000, immutable"
    });
  });

  return app;
}

export function mediaRoutes(deps: MediaDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.route("/", mediaUploadRoutes(deps));
  app.route("/", mediaReadRoutes(deps));
  return app;
}
