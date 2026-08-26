import {
  createClickHouseClient,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import { runMigrations as runPgMigrations } from "@ironside/db";
import { createIngestQueue } from "@ironside/queue";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestMachineCredential } from "./helpers/machine-credential.js";
import { createTestOwnerSession, ownerHeaders } from "./helpers/owner-session.js";

// Media assets (M9-09): blobs to object storage, refs into trace JSON.

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

const app = createApp({
  pgPool: pool,
  clickhouse,
  redis,
  storage,
  queue,
  webOrigins: ["http://localhost:5174"],
  defaultRateLimitPerMinute: 10000
});

let apiKey: string;
let otherProjectKey: string;
let projectId: string;
let otherProjectId: string;
let ownerCookie: string;

// A tiny real PNG (1x1 transparent pixel) — binary bytes, not text, so the
// round-trip proves byte fidelity rather than string survival.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();
  const owner = await createTestOwnerSession(pool);
  const orgId = owner.organizationId;
  ownerCookie = owner.cookie;
  projectId = `proj_${ulid()}`;
  otherProjectId = `proj_${ulid()}`;
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3), ($4, $2, $5)",
    [projectId, orgId, "media-test", otherProjectId, "media-test-other"]
  );
  apiKey = (await createTestMachineCredential(pool, projectId, "media-test", "ingest")).token;
  otherProjectKey = (await createTestMachineCredential(pool, otherProjectId, "media-test-other", "ingest")).token;
});

afterAll(async () => {
  await pool.query("delete from projects where id = any($1)", [[projectId, otherProjectId]]);
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

async function upload(body: Buffer, contentType: string, key = apiKey) {
  return app.request("/api/v1/media", {
    method: "POST",
    body,
    headers: { authorization: `Bearer ${key}`, "content-type": contentType }
  });
}

describe("media assets", () => {
  it("uploads bytes and serves them back byte-identical with the stored content type", async () => {
    const uploadRes = await upload(PNG_BYTES, "image/png");
    expect(uploadRes.status).toBe(201);
    const created = (await uploadRes.json()) as {
      id: string;
      ref: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
    };
    expect(created.ref).toBe(`ironside://media/${created.id}`);
    expect(created.contentType).toBe("image/png");
    expect(created.sizeBytes).toBe(PNG_BYTES.byteLength);

    const getRes = await app.request(`/api/v1/projects/${projectId}/media/${created.id}`, {
      headers: ownerHeaders(ownerCookie)
    });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await getRes.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
  });

  it("re-uploading identical bytes dedupes to the same asset id", async () => {
    const first = (await (await upload(PNG_BYTES, "image/png")).json()) as { id: string };
    const second = (await (await upload(PNG_BYTES, "image/png")).json()) as { id: string };
    expect(second.id).toBe(first.id);
  });

  it("re-uploading identical bytes with a DIFFERENT content type returns the original asset and does NOT rewrite the stored object (review finding)", async () => {
    const first = (await (await upload(PNG_BYTES, "image/png")).json()) as {
      id: string;
      contentType: string;
    };
    const second = (await (await upload(PNG_BYTES, "text/html")).json()) as {
      id: string;
      contentType: string;
    };
    // First write wins: same asset, original content type.
    expect(second.id).toBe(first.id);
    expect(second.contentType).toBe("image/png");
    // And the stored object's own metadata was not silently rewritten.
    const projectRow = await pool.query<{ object_key: string }>(
      "select object_key from media_assets where id = $1",
      [first.id]
    );
    const stored = await storage.getBytes(projectRow.rows[0]!.object_key);
    expect(stored.contentType).toBe("image/png");
  });

  it("GET serves hardening headers (nosniff, no-script CSP, disposition) alongside the stored content type", async () => {
    const created = (await (await upload(PNG_BYTES, "image/png")).json()) as { id: string };
    const res = await app.request(`/api/v1/projects/${projectId}/media/${created.id}`, {
      headers: ownerHeaders(ownerCookie)
    });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-disposition")).toContain("inline");

    // Non-image (and svg, which can script) types are attachment-only.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const svgAsset = (await (await upload(svg, "image/svg+xml")).json()) as { id: string };
    const svgRes = await app.request(`/api/v1/projects/${projectId}/media/${svgAsset.id}`, {
      headers: ownerHeaders(ownerCookie)
    });
    expect(svgRes.headers.get("content-disposition")).toContain("attachment");
  });

  it("another project's key cannot read the asset (404, indistinguishable from absent)", async () => {
    const created = (await (await upload(PNG_BYTES, "image/png")).json()) as { id: string };
    const res = await app.request(`/api/v1/projects/${otherProjectId}/media/${created.id}`, {
      headers: ownerHeaders(ownerCookie)
    });
    expect(res.status).toBe(404);
  });

  it("the same bytes uploaded by two projects are separate assets (content addressing is per-project)", async () => {
    const mine = (await (await upload(PNG_BYTES, "image/png")).json()) as { id: string };
    const theirs = (await (await upload(PNG_BYTES, "image/png", otherProjectKey)).json()) as { id: string };
    expect(theirs.id).not.toBe(mine.id);
  });

  it("rejects an empty body and form encodings", async () => {
    expect((await upload(Buffer.alloc(0), "image/png")).status).toBe(400);
    expect((await upload(PNG_BYTES, "multipart/form-data")).status).toBe(415);
  });

  it("unknown asset id is a 404", async () => {
    const res = await app.request(`/api/v1/projects/${projectId}/media/${ulid()}`, {
      headers: ownerHeaders(ownerCookie)
    });
    expect(res.status).toBe(404);
  });

  it("requires auth", async () => {
    const res = await app.request("/api/v1/media", {
      method: "POST",
      body: PNG_BYTES,
      headers: { "content-type": "image/png" }
    });
    expect(res.status).toBe(401);
  });
});
