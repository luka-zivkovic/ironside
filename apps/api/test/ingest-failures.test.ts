import { recordIngestFailures, runMigrations as runPgMigrations } from "@ironside/db";
import { createClickHouseClient, runMigrations as runChMigrations } from "@ironside/clickhouse";
import { createIngestQueue } from "@ironside/queue";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestOwnerSession, ownerHeaders } from "./helpers/owner-session.js";

// GET /api/v1/ingest-failures (M9-03): the read-only dead-letter view.

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

const app = createApp({ pgPool: pool, clickhouse, redis, storage, queue, webOrigins: ["http://localhost:5174"], defaultRateLimitPerMinute: 10000 });

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
    [projectId, orgId, "ingest-failures-api-test", otherProjectId, "ingest-failures-api-test-other"]
  );
});

afterAll(async () => {
  await pool.query("delete from projects where id = any($1)", [[projectId, otherProjectId]]);
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

describe("GET /api/v1/ingest-failures", () => {
  it("rejects requests without a valid owner session", async () => {
    const res = await app.request(`/api/v1/projects/${projectId}/ingest-failures`);
    expect(res.status).toBe(401);
  });

  it("lists the caller's project's failures with full pointer fields; another project's key sees none of them", async () => {
    const mine = {
      id: `ingfail_${ulid()}`,
      projectId,
      batchId: `batch_${ulid()}`,
      objectKey: `raw/x/y/${ulid()}.json`,
      eventId: `evt_${ulid()}`,
      source: "langfuse",
      eventType: "langfuse-ingestion",
      error: "event failed LangFuse mapping"
    };
    await recordIngestFailures(pool, [mine]);

    const res = await app.request(`/api/v1/projects/${projectId}/ingest-failures`, {
      headers: ownerHeaders(ownerCookie)
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { failures: Record<string, unknown>[] };
    const row = body.failures.find((f) => f.id === mine.id);
    expect(row).toMatchObject({
      batchId: mine.batchId,
      objectKey: mine.objectKey,
      eventId: mine.eventId,
      source: "langfuse",
      eventType: "langfuse-ingestion",
      error: mine.error
    });
    expect(typeof row?.createdAt).toBe("string");

    const otherRes = await app.request(`/api/v1/projects/${otherProjectId}/ingest-failures`, {
      headers: ownerHeaders(ownerCookie)
    });
    const otherBody = (await otherRes.json()) as { failures: { id: string }[] };
    expect(otherBody.failures.map((f) => f.id)).not.toContain(mine.id);
  });

  it("rejects an out-of-range limit with 400", async () => {
    const res = await app.request(`/api/v1/projects/${projectId}/ingest-failures?limit=5000`, {
      headers: ownerHeaders(ownerCookie)
    });
    expect(res.status).toBe(400);
  });
});
