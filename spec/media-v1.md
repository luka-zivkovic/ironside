# Media Assets v1 (M9-09)

Status: implemented. Owner: `apps/api/src/routes/media.ts`, `packages/db/src/media-assets.ts`, `packages/storage` (`putBytes`/`getBytes`), `packages/sdk` (`uploadMedia`), `apps/web/src/screens/trace.tsx` (`MediaPreview`).

## Problem

Trace `input`/`output` are JSON text columns in ClickHouse. Base64-embedding an image (or audio/document) there bloats the columnar store and every query touching the column — multimodal traces need blobs out-of-band.

## Design

**Blobs to object storage, refs in the JSON.**

- `POST /api/v1/media` — raw bytes with their real `content-type` header (multipart/form encodings rejected 415; empty body 400; size bounded by the app-wide 10MB bodyLimit). The blob is written to `media/{projectId}/{sha256}` (content-addressed → identical bytes dedupe to one object), and a baseline `media_assets` row records id/ownership/content type/size. Returns `{id, ref, contentType, sizeBytes, sha256}` where `ref` is:

  ```
  ironside://media/<ulid>
  ```

- Dedup: `ON CONFLICT (project_id, sha256) DO UPDATE ... RETURNING` — re-uploading identical bytes returns the **existing** asset id (the no-op update is what makes RETURNING yield the row; DO NOTHING returns nothing). Content addressing is **per project**: the same bytes uploaded by two projects are two assets — sharing one object across tenants would leak existence information.
- `GET /api/v1/media/:id` — project-scoped lookup (another project's key gets 404, indistinguishable from absent), streams the bytes with the stored content type and `Cache-Control: private, max-age=31536000, immutable` (content-addressed, safe to cache hard).
- **SDK**: `ironside.uploadMedia({data, contentType})` → `{ref, ...}`; the caller embeds the ref string anywhere in trace input/output/metadata. Unlike instrumentation calls it awaits the network — the ref doesn't exist until the server has the bytes.
- **Viewer**: `JsonBlock` scans the serialized input/output for `ironside://media/<ulid>` refs (string scan — refs at any nesting depth are found without walking the object). Each ref is fetched through the authed API (`<img src>` can't carry an Authorization header, so blob → object URL), rendered inline for `image/*`, as a download link otherwise, and as a quiet "unavailable" note on fetch failure.

**Deliberately NOT part of the ingest event pipeline**: media is immutable, has no per-event semantics, and replaying raw batches must not require re-uploading blobs. The write order (object first, row second) means a crashed upload can only orphan a blob that a retried upload reuses — never a row whose GET would 500.

## Review findings (PR #41)

1. **Should-fix (fixed)**: re-uploading identical bytes with a *different* content type overwrote the stored object's ContentType metadata while the row kept the original — a row/object inconsistency waiting for anything that reads the object directly. Fixed with a dedup check **before** touching storage (assets are now genuinely first-write-wins immutable), regression-tested including the object-metadata assertion.
2. **Hardening (applied)**: GET serves caller-supplied bytes with a caller-supplied content type from the API origin. Not currently exploitable — bearer-only auth means a third-party page's `<img>`/`<script>` can never authenticate the request — but `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and `Content-Disposition: attachment` for non-image types (svg included — it can script) keep it unexploitable if a future code path exposes the response to direct navigation. Deliberately **not** an upload allowlist: Ironside stores what it's given (an LLM app's html/svg artifact is legitimate data); execution is denied at the serving path instead.

Reviewer verified clean: parameterized queries (no injection), ON CONFLICT...RETURNING returns the existing row, ULID regex charset, matchAll statefulness, object-URL lifecycle on unmount.

## Known limits (v1, tracked not hidden)

- **No retention/GC**: media is not covered by the retention sweep (the raw event log has the same gap — both tracked in ROADMAP).
- **10MB per asset** (shared bodyLimit). Raising it for media specifically is a follow-up if real usage demands it.
- **No listing endpoint** — assets are reachable only via refs embedded in traces.
- **No component test for the viewer preview** (apps/web still has no React test infra — same honest gap as M7; the API contract underneath is fully tested).

## Verification

- `apps/api/test/media.test.ts` — byte-identical round-trip of a real PNG (binary, not text), dedup returns the same id, cross-project GET is 404, same bytes in two projects are distinct assets, empty-body 400 / form-encoding 415, unknown id 404, auth required.
- `packages/sdk/test/client.test.ts` — uploadMedia sends raw bytes + content type + bearer, returns the ref, no double-slash on trailing-slash hosts, structured error on failure.
- **Live e2e** against the running compose stack: real PNG uploaded via the SDK → ref embedded in a generation's output → media fetched back byte-identical with `image/png`; sha256 matched locally computed. UI preview verified by typecheck + the tested API contract only (no browser tooling available in this environment — same limitation noted in M7).
