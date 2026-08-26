import { getOtlpForwardRule, runMigrations as runPgMigrations } from "@ironside/db";
import { createClickHouseClient, runMigrations as runChMigrations } from "@ironside/clickhouse";
import { createIngestQueue } from "@ironside/queue";
import { decryptSecret } from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestMachineCredential } from "./helpers/machine-credential.js";
import { createTestOwnerSession, ownerHeaders } from "./helpers/owner-session.js";

// Integration tests for the M6-06 day-2 CRUD routes: exports, OTLP
// forwards, webhooks. Covers each once in full, then the shared
// cross-cutting contracts (secrets never echoed back, project scoping,
// pollIntervalSeconds override) across all three without re-testing every
// field permutation three times.

process.env.IRONSIDE_ENCRYPTION_SECRET ??= "scheduled-destinations-test-secret";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

const app = createApp({ pgPool: pool, clickhouse, redis, storage, queue, webOrigins: ["http://localhost:5174"], defaultRateLimitPerMinute: 10000 });

let apiKey: string;
let otherProjectApiKey: string;
let projectId: string;
let otherProjectId: string;
let ownerCookie: string;

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
    [projectId, orgId, "scheduled-destinations-test", otherProjectId, "scheduled-destinations-test-other"]
  );
  apiKey = (await createTestMachineCredential(pool, projectId, "scheduled-destinations-test", "ingest")).token;
  otherProjectApiKey = (await createTestMachineCredential(pool, otherProjectId, "other", "ingest")).token;
});

afterAll(async () => {
  await pool.query("delete from projects where id = any($1)", [[projectId, otherProjectId]]);
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

async function req(method: string, path: string, key: string, body?: unknown) {
  const targetProjectId = key === otherProjectApiKey ? otherProjectId : projectId;
  return app.request(path.replace("/api/v1", `/api/v1/projects/${targetProjectId}`), {
    method,
    headers: ownerHeaders(ownerCookie, {
      ...(body !== undefined && { "content-type": "application/json" })
    }),
    ...(body !== undefined && { body: JSON.stringify(body) })
  });
}

describe("exports CRUD (/api/v1/exports)", () => {
  it("rejects requests without a valid API key", async () => {
    const res = await app.request(`/api/v1/projects/${projectId}/exports`);
    expect(res.status).toBe(401);
  });

  it("creates, lists, patches, and deletes an export config; the secret is never echoed back", async () => {
    const create = await req("POST", "/api/v1/exports", apiKey, {
      name: "nightly-export",
      format: "parquet",
      filter: { tags: ["prod"] },
      destinationBucket: "my-bucket",
      destinationEndpoint: "https://s3.example.com",
      destinationAccessKeyId: "AKIA...",
      destinationSecretAccessKey: "super-secret-value"
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as Record<string, unknown>;
    expect(created.name).toBe("nightly-export");
    expect(created.format).toBe("parquet");
    expect(created.filter).toEqual({ tags: ["prod"] });
    expect(created.enabled).toBe(true);
    expect("destinationSecretAccessKey" in created).toBe(false);
    expect(JSON.stringify(created)).not.toContain("super-secret-value");
    // Server-generated scheduling fields present without the caller providing them.
    expect(created.pollIntervalSeconds).toBeGreaterThan(0);
    expect(created.nextRunAt).toBeTruthy();

    const list = await req("GET", "/api/v1/exports", apiKey);
    const body = (await list.json()) as { exports: { id: string }[] };
    expect(body.exports.map((e) => e.id)).toContain(created.id);

    const patch = await req("PATCH", `/api/v1/exports/${created.id}`, apiKey, { enabled: false });
    expect(patch.status).toBe(200);
    expect((await patch.json() as { enabled: boolean }).enabled).toBe(false);

    const del = await req("DELETE", `/api/v1/exports/${created.id}`, apiKey);
    expect(del.status).toBe(204);

    const afterDelete = await req("GET", "/api/v1/exports", apiKey);
    const afterBody = (await afterDelete.json()) as { exports: { id: string }[] };
    expect(afterBody.exports.map((e) => e.id)).not.toContain(created.id);
  });

  it("rejects an invalid create request with 400", async () => {
    const res = await req("POST", "/api/v1/exports", apiKey, { name: "" });
    expect(res.status).toBe(400);
  });

  it("a caller cannot read, patch, or delete another project's export config", async () => {
    const create = await req("POST", "/api/v1/exports", apiKey, {
      name: "isolation-test",
      destinationBucket: "b",
      destinationEndpoint: "https://s3.example.com",
      destinationAccessKeyId: "k",
      destinationSecretAccessKey: "s"
    });
    const created = (await create.json()) as { id: string };

    const list = await req("GET", "/api/v1/exports", otherProjectApiKey);
    const body = (await list.json()) as { exports: { id: string }[] };
    expect(body.exports.map((e) => e.id)).not.toContain(created.id);

    const patch = await req("PATCH", `/api/v1/exports/${created.id}`, otherProjectApiKey, { enabled: false });
    expect(patch.status).toBe(404);

    const del = await req("DELETE", `/api/v1/exports/${created.id}`, otherProjectApiKey);
    expect(del.status).toBe(404);
  });

  it("accepts a caller-supplied pollIntervalSeconds override at create time", async () => {
    const create = await req("POST", "/api/v1/exports", apiKey, {
      name: "custom-interval",
      destinationBucket: "b",
      destinationEndpoint: "https://s3.example.com",
      destinationAccessKeyId: "k",
      destinationSecretAccessKey: "s",
      pollIntervalSeconds: 7200
    });
    const created = (await create.json()) as { pollIntervalSeconds: number };
    expect(created.pollIntervalSeconds).toBe(7200);
  });

  it("rejects an explicit {enabled: null} with 400 rather than silently no-op'ing it via SQL COALESCE — enabled is boolean-optional, not nullable", async () => {
    const create = await req("POST", "/api/v1/exports", apiKey, {
      name: "null-enabled-test",
      destinationBucket: "b",
      destinationEndpoint: "https://s3.example.com",
      destinationAccessKeyId: "k",
      destinationSecretAccessKey: "s"
    });
    const created = (await create.json()) as { id: string };

    const patch = await req("PATCH", `/api/v1/exports/${created.id}`, apiKey, { enabled: null });
    expect(patch.status).toBe(400);
  });
});

describe("OTLP forwards CRUD (/api/v1/otlp-forwards)", () => {
  it("creates, lists, patches, and deletes a forward rule; the auth header is never echoed back", async () => {
    const create = await req("POST", "/api/v1/otlp-forwards", apiKey, {
      name: "collector-forward",
      destinationUrl: "https://collector.example.com/v1/traces",
      destinationAuthHeader: "Bearer super-secret-token",
      filter: {}
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as Record<string, unknown>;
    expect(created.destinationUrl).toBe("https://collector.example.com/v1/traces");
    expect(created.hasDestinationAuthHeader).toBe(true);
    expect("destinationAuthHeader" in created).toBe(false);
    expect(JSON.stringify(created)).not.toContain("super-secret-token");

    const list = await req("GET", "/api/v1/otlp-forwards", apiKey);
    const body = (await list.json()) as { forwards: { id: string }[] };
    expect(body.forwards.map((f) => f.id)).toContain(created.id);

    const patch = await req("PATCH", `/api/v1/otlp-forwards/${created.id}`, apiKey, {
      pollIntervalSeconds: 120
    });
    expect((await patch.json() as { pollIntervalSeconds: number }).pollIntervalSeconds).toBe(120);

    const del = await req("DELETE", `/api/v1/otlp-forwards/${created.id}`, apiKey);
    expect(del.status).toBe(204);
  });

  it("the stored auth header actually decrypts back to what the caller sent — not just that it's not echoed", async () => {
    const create = await req("POST", "/api/v1/otlp-forwards", apiKey, {
      name: "auth-header-roundtrip",
      destinationUrl: "https://collector.example.com/v1/traces",
      destinationAuthHeader: "Bearer roundtrip-secret-value",
      filter: {}
    });
    const created = (await create.json()) as { id: string };

    const stored = await getOtlpForwardRule(pool, projectId, created.id);
    expect(stored?.destinationAuthHeaderEncrypted).toBeTruthy();
    expect(decryptSecret(stored!.destinationAuthHeaderEncrypted!)).toBe("Bearer roundtrip-secret-value");
  });

  it("hasDestinationAuthHeader is false when no auth header was provided (no auth needed for the destination)", async () => {
    const create = await req("POST", "/api/v1/otlp-forwards", apiKey, {
      name: "no-auth-forward",
      destinationUrl: "https://collector.example.com/v1/traces",
      filter: {}
    });
    const created = (await create.json()) as { hasDestinationAuthHeader: boolean };
    expect(created.hasDestinationAuthHeader).toBe(false);
  });

  it("rejects a non-URL destinationUrl with 400", async () => {
    const res = await req("POST", "/api/v1/otlp-forwards", apiKey, {
      name: "bad-url",
      destinationUrl: "not-a-url",
      filter: {}
    });
    expect(res.status).toBe(400);
  });

  it("a caller cannot read, patch, or delete another project's forward rule", async () => {
    const create = await req("POST", "/api/v1/otlp-forwards", apiKey, {
      name: "isolation-test",
      destinationUrl: "https://collector.example.com/v1/traces",
      filter: {}
    });
    const created = (await create.json()) as { id: string };

    const list = await req("GET", "/api/v1/otlp-forwards", otherProjectApiKey);
    const body = (await list.json()) as { forwards: { id: string }[] };
    expect(body.forwards.map((f) => f.id)).not.toContain(created.id);

    const patch = await req("PATCH", `/api/v1/otlp-forwards/${created.id}`, otherProjectApiKey, {
      enabled: false
    });
    expect(patch.status).toBe(404);

    const del = await req("DELETE", `/api/v1/otlp-forwards/${created.id}`, otherProjectApiKey);
    expect(del.status).toBe(404);
  });
});

describe("webhooks CRUD (/api/v1/webhooks)", () => {
  it("creates, lists, patches, and deletes a webhook rule; no signing secret is ever accepted from or returned to the caller", async () => {
    const create = await req("POST", "/api/v1/webhooks", apiKey, {
      name: "order-webhook",
      destinationUrl: "https://example.com/hook",
      filter: { userId: "user_1" }
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as Record<string, unknown>;
    expect(created.destinationUrl).toBe("https://example.com/hook");
    expect(created.filter).toEqual({ userId: "user_1" });
    // No signingSecret field exists anywhere in the request schema or the
    // response shape — the server generates and owns it entirely.
    expect("signingSecret" in created).toBe(false);
    expect("signingSecretEncrypted" in created).toBe(false);

    const list = await req("GET", "/api/v1/webhooks", apiKey);
    const body = (await list.json()) as { webhooks: { id: string }[] };
    expect(body.webhooks.map((w) => w.id)).toContain(created.id);

    const patch = await req("PATCH", `/api/v1/webhooks/${created.id}`, apiKey, { enabled: false });
    expect((await patch.json() as { enabled: boolean }).enabled).toBe(false);

    const del = await req("DELETE", `/api/v1/webhooks/${created.id}`, apiKey);
    expect(del.status).toBe(204);
  });

  it("404s patching/deleting a nonexistent webhook rule", async () => {
    const patch = await req("PATCH", `/api/v1/webhooks/webhook_${ulid()}`, apiKey, { enabled: false });
    expect(patch.status).toBe(404);
    const del = await req("DELETE", `/api/v1/webhooks/webhook_${ulid()}`, apiKey);
    expect(del.status).toBe(404);
  });

  it("a caller cannot read, patch, or delete another project's webhook rule", async () => {
    const create = await req("POST", "/api/v1/webhooks", apiKey, {
      name: "isolation-test",
      destinationUrl: "https://example.com/hook",
      filter: {}
    });
    const created = (await create.json()) as { id: string };

    const list = await req("GET", "/api/v1/webhooks", otherProjectApiKey);
    const body = (await list.json()) as { webhooks: { id: string }[] };
    expect(body.webhooks.map((w) => w.id)).not.toContain(created.id);

    const patch = await req("PATCH", `/api/v1/webhooks/${created.id}`, otherProjectApiKey, {
      enabled: false
    });
    expect(patch.status).toBe(404);

    const del = await req("DELETE", `/api/v1/webhooks/${created.id}`, otherProjectApiKey);
    expect(del.status).toBe(404);
  });
});
