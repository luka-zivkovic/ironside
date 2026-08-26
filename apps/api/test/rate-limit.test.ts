import { createClickHouseClient } from "@ironside/clickhouse";
import { runMigrations, setProjectQuotas } from "@ironside/db";
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

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

// Tiny limits so tests can hit them deterministically in a handful of
// requests without a long-running loop.
const app = createApp({
  pgPool: pool,
  clickhouse,
  redis,
  storage,
  queue,
  webOrigins: ["http://localhost:5174"],
  defaultRateLimitPerMinute: 3,
  rawEventsRateLimitPerMinute: 2
});

let projectId: string;
let apiKey: string;
let ownerCookie: string;
let ownerOrganizationId: string;
const seededProjectIds: string[] = [];

async function seedProject(name: string): Promise<{ projectId: string; apiKey: string }> {
  const newProjectId = `proj_${ulid()}`;
  await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
    newProjectId,
    ownerOrganizationId,
    name
  ]);
  seededProjectIds.push(newProjectId);
  const key = await createTestMachineCredential(pool, newProjectId, name, "ingest");
  return { projectId: newProjectId, apiKey: key.token };
}

function tracePayload() {
  return {
    events: [
      {
        type: "trace-upsert",
        body: { id: `trace_${ulid()}`, timestamp: new Date().toISOString(), metadata: {} }
      }
    ]
  };
}

async function ingest(token: string) {
  return app.request("/api/v1/ingest", {
    method: "POST",
    body: JSON.stringify(tracePayload()),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }
  });
}

async function uploadMedia(token: string, byte: number) {
  return app.request("/api/v1/media", {
    method: "POST",
    body: new Uint8Array([byte]),
    headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` }
  });
}

beforeAll(async () => {
  await runMigrations(pool);
  await storage.ensureBucket();
  const owner = await createTestOwnerSession(pool);
  ownerCookie = owner.cookie;
  ownerOrganizationId = owner.organizationId;
  const seeded = await seedProject("rate-limit-test");
  projectId = seeded.projectId;
  apiKey = seeded.apiKey;
});

afterAll(async () => {
  await pool.query("delete from projects where id = any($1)", [seededProjectIds]);
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

describe("ingest rate limiting", () => {
  it("allows requests up to the limit, then rejects with 429 and Retry-After", async () => {
    const first = await ingest(apiKey);
    expect(first.status).toBe(202);
    const second = await ingest(apiKey);
    expect(second.status).toBe(202);
    const third = await ingest(apiKey);
    expect(third.status).toBe(202);

    const fourth = await ingest(apiKey);
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get("Retry-After")).toBeTruthy();
    const body = (await fourth.json()) as { error: string };
    expect(body.error).toMatch(/rate limit exceeded/);
  });

  it("query and management routes are not rate limited even after ingest exhausts the limit", async () => {
    // The previous test already exhausted this project's ingest limit —
    // query/management routes must still work.
    const res = await app.request(`/api/v1/projects/${projectId}/traces?limit=1`, {
      headers: ownerHeaders(ownerCookie)
    });
    expect(res.status).toBe(200);
  });

  it("rate limits are tracked independently per project", async () => {
    const other = await seedProject("rate-limit-query-unaffected");
    // This project has never made a request — its own limit is fresh
    // even though the first project's limit above is exhausted.
    const res = await ingest(other.apiKey);
    expect(res.status).toBe(202);
  });

  it("a project-level rate_limit_per_minute override replaces the platform default", async () => {
    const custom = await seedProject("rate-limit-quota-test");
    await setProjectQuotas(pool, custom.projectId, { rateLimitPerMinute: 1 });

    const first = await ingest(custom.apiKey);
    expect(first.status).toBe(202);

    // Wait out the quota-override Redis cache TTL is NOT needed here —
    // the override is read fresh on this project's first rate-limited
    // request since nothing cached it yet in this test run.
    const second = await ingest(custom.apiKey);
    expect(second.status).toBe(429);
  });

  it("media upload shares the same project write budget as ingest", async () => {
    const shared = await seedProject("rate-limit-media-shared-budget");
    expect((await ingest(shared.apiKey)).status).toBe(202);
    expect((await uploadMedia(shared.apiKey, 1)).status).toBe(201);
    expect((await uploadMedia(shared.apiKey, 2)).status).toBe(201);
    expect((await uploadMedia(shared.apiKey, 3)).status).toBe(429);
  });
});

describe("raw-events rate limiting", () => {
  it("enforces its own limit, ignores the ingest override, and keeps a separate budget from ingest", async () => {
    const seeded = await seedProject("rate-limit-raw-events");
    // A generous INGEST override must NOT raise the raw-events limit —
    // the lookup's policy is independent (useProjectOverride: false).
    await setProjectQuotas(pool, seeded.projectId, { rateLimitPerMinute: 100 });

    const lookup = () =>
      app.request(`/api/v1/projects/${seeded.projectId}/traces/trace_${ulid()}/raw-events`, {
        headers: ownerHeaders(ownerCookie)
      });

    // Two requests pass (404: nonexistent trace — the limiter runs before
    // the route), the third trips the raw-events limit of 2/min.
    expect((await lookup()).status).toBe(404);
    expect((await lookup()).status).toBe(404);
    const third = await lookup();
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBeTruthy();
    const body = (await third.json()) as { error: string };
    expect(body.error).toMatch(/rate limit exceeded/);

    // The raw-events counter lives under its own Redis scope: the same
    // project can still ingest even though its raw-events budget is spent.
    const ingestRes = await ingest(seeded.apiKey);
    expect(ingestRes.status).toBe(202);
  });
});
