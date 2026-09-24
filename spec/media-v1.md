# Media Assets v1

Status: implemented. Owner: `apps/api/src/routes/media.ts`, `packages/db/src/media-assets.ts`, `packages/storage/src/index.ts` (`putBytes`, `getBytes`), `packages/sdk/src/client.ts` (`uploadMedia`), `apps/web/src/screens/trace.tsx` (`MediaPreview`).

## Purpose

Keep images, audio and documents out of trace JSON. Trace `input` and `output` are JSON text columns in ClickHouse, and base64 blobs there bloat the store and every query that reads those columns. Blobs go to object storage, and traces carry a short reference to them.

## References

A media reference is the string `ironside://media/<id>`, where `<id>` is the asset's 26-character ULID. A client embeds it anywhere in trace or observation input, output or metadata. Ingest does not interpret it.

Media is not part of the ingest event pipeline: assets are immutable, have no per-event semantics, and replaying raw batches must not require uploading blobs again.

## Upload

`POST /api/v1/media`

- Authentication: a machine credential with the `media:write` capability, which the Ingest preset includes (`spec/scoped-machine-credentials-v1.md`). Uploads count against the project's shared write rate limit, together with ingest.
- Body: the raw bytes with their real `Content-Type`. A missing content type, `multipart/form-data`, or `application/x-www-form-urlencoded` returns 415. An empty body returns 400. The app-wide 10 MiB body limit applies (413).
- The content type is stored lower-cased and without parameters.
- The API hashes the bytes with SHA-256, writes them to object storage at `media/{projectId}/{sha256}`, then inserts a `media_assets` row with the id, project, hash, content type, size and object key.
- Response: 201 with `{ id, ref, contentType, sizeBytes, sha256 }`, where `ref` is `ironside://media/<id>`.

Deduplication is by content, per project:

- If the project already has an asset with the same hash, the upload returns that asset, with its original id and content type, and does not touch storage. Assets are first-write-wins and immutable, so a later upload with a different content type cannot change the stored object.
- The same bytes uploaded by two projects are two assets. Sharing one object across tenants would reveal that another project stored the same content.
- Two concurrent first uploads of the same bytes both write the object, and the insert returns the row that won:

  ```sql
  insert into media_assets (id, project_id, sha256, content_type, size_bytes, object_key)
  values ($1, $2, $3, $4, $5, $6)
  on conflict (project_id, sha256) do update set sha256 = excluded.sha256
  returning id, project_id, sha256, content_type, size_bytes, object_key, created_at
  ```

  The no-op update is what makes `returning` yield the existing row; `do nothing` would return no row.

The object is written before the row. A failed upload can leave only an object without a row, which a retry of the same bytes reuses; it never leaves a row whose object is missing.

## Read

`GET /api/v1/projects/:projectId/media/:id`

- Authentication: an owner session. The project is resolved through the owner's organization, and a missing or foreign project returns 404 (`spec/project-session-routing-v1.md`). Machine credentials cannot read media.
- The lookup is scoped to the project in the URL. An unknown id, or an asset of another project, returns 404.
- The response carries the stored bytes with these headers:
  - `Content-Type`: the stored content type; `Content-Length`: the stored size.
  - `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.
  - `Content-Disposition: inline; filename="<id>"` for `image/*` types except `image/svg+xml`, and `attachment; filename="<id>"` for every other type, because SVG can run script.
  - `Cache-Control: private, max-age=31536000, immutable`, since an asset never changes.

This route serves bytes and a content type chosen by a client from the API origin. Uploads are not limited to an allowlist, because an LLM application's HTML or SVG output is legitimate data; the headers deny execution where the bytes are served instead.

## SDK

`ironside.uploadMedia({ data, contentType })` takes a `Uint8Array` or `ArrayBuffer`, posts it to `/api/v1/media` with the client's bearer token and the given content type, and resolves to `{ id, ref, contentType, sizeBytes, sha256 }`. A non-2xx response throws an `Error` whose message holds the status and response body. Unlike instrumentation calls, it awaits the network: the reference does not exist until the server has stored the bytes.

## Viewer

The trace view scans the serialized input and output of the trace and of each observation for references (`MEDIA_REF_PATTERN` in `apps/web/src/lib/api.ts`), so a reference at any nesting depth is found. Each distinct id is fetched once through the owner-session read route as a blob and shown through an object URL, which is revoked on unmount. `image/*` content renders inline as an image, other types as a download link, and a failed fetch as the note `media <id>: unavailable`. References in metadata are not previewed.

## Limits

- 10 MiB per asset, the shared request body limit.
- No listing endpoint: an asset is reachable only through a reference.
- Retention never deletes media. Lifecycle planning reports only the registered asset count and size (`summarizeMediaStorage`, `spec/lifecycle-planning-v1.md`), because a content-addressed asset can be reused by newer traces and there is no authoritative record of which traces reference which assets.

## Verified

`apps/api/test/media.test.ts` covers a byte-identical round trip of a PNG through upload and the owner read route, deduplication to the same id, a second upload with a different content type returning the original asset without rewriting the stored object, the hardening headers (inline for PNG, attachment for SVG), 404 for another project's URL and for an unknown id, separate assets for the same bytes in two projects, 400 for an empty body, 415 for form encoding, and 401 for an unauthenticated upload. `apps/api/test/rate-limit.test.ts` checks that media uploads share the project write budget with ingest. `packages/sdk/test/client.test.ts` checks that `uploadMedia` sends the raw bytes with the content type and bearer token to a normalized host URL, returns the reference, and throws with the server's error text on failure. `packages/db/test/media-storage-summary.test.ts` covers the storage inventory. The viewer preview has no automated test.

## History

- M9-09 added media assets.
- Review of PR #41 found that uploading identical bytes with a different content type overwrote the stored object's content type while the row kept the original. The deduplication check now runs before any storage write. The same review added the hardening headers on reads, although at the time only bearer-authenticated requests could read media, so a third-party page could not load it.
- Media reads were first `GET /api/v1/media/:id`, authenticated with the project's bearer key. They moved to the owner-session project route with the project-explicit session routing of issue #64 (`spec/project-session-routing-v1.md`), and issue #65 introduced the `media:write` capability for uploads (`spec/scoped-machine-credentials-v1.md`).
- Still open: media garbage collection, which needs an authoritative trace-to-media reference record first.
