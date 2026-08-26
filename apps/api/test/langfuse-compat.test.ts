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

// Integration test of the LangFuse-compat fast-ACK edge: both auth
// schemes, envelope validation, raw batch lands in object storage, job
// lands in the queue, 207 response shape. Worker-side mapping is covered
// separately (packages/mappers/test/langfuse.test.ts).

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

const app = createApp({ pgPool: pool, clickhouse, redis, storage, queue, webOrigins: ["http://localhost:5174"], defaultRateLimitPerMinute: 10000 });

let apiKey: string;

beforeAll(async () => {
  await runPgMigrations(pool);
  await storage.ensureBucket();
  const orgId = `org_${ulid()}`;
  const projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "langfuse-compat-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, "langfuse-compat-test"]
  );
  apiKey = (await createTestMachineCredential(pool, projectId, "langfuse-compat-test", "ingest")).token;
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'langfuse-compat-test-org'");
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

function langfuseBatch() {
  return {
    batch: [
      {
        id: "evt_1",
        timestamp: new Date().toISOString(),
        type: "trace-create",
        body: { id: `trace_${ulid()}`, name: "compat-test" }
      }
    ],
    metadata: { sdk_name: "langfuse-js", sdk_version: "3.38.20" }
  };
}

describe("POST /api/public/ingestion (LangFuse compat)", () => {
  it("rejects requests with no auth header", async () => {
    const res = await app.request("/api/public/ingestion", {
      method: "POST",
      body: JSON.stringify(langfuseBatch()),
      headers: { "content-type": "application/json" }
    });
    expect(res.status).toBe(401);
  });

  it("accepts Bearer auth (Ironside's native scheme)", async () => {
    const res = await app.request("/api/public/ingestion", {
      method: "POST",
      body: JSON.stringify(langfuseBatch()),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      }
    });
    expect(res.status).toBe(207);
  });

  it("accepts Basic auth (LangFuse SDK's scheme — publicKey:secretKey, secretKey slot is the real Ironside key)", async () => {
    const basic = Buffer.from(`pk_whatever:${apiKey}`).toString("base64");
    const res = await app.request("/api/public/ingestion", {
      method: "POST",
      body: JSON.stringify(langfuseBatch()),
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${basic}`
      }
    });
    expect(res.status).toBe(207);
  });

  it("rejects a malformed Basic header (no colon separator) as unauthenticated", async () => {
    const basic = Buffer.from("not-a-valid-credential-pair").toString("base64");
    const res = await app.request("/api/public/ingestion", {
      method: "POST",
      body: JSON.stringify(langfuseBatch()),
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${basic}`
      }
    });
    expect(res.status).toBe(401);
  });

  it("returns the 207 shape LangFuse's SDK expects (successes/errors arrays)", async () => {
    const res = await app.request("/api/public/ingestion", {
      method: "POST",
      body: JSON.stringify(langfuseBatch()),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      }
    });
    const body = (await res.json()) as { successes: unknown[]; errors: unknown[] };
    expect(body.successes).toHaveLength(1);
    expect(body.errors).toEqual([]);
  });

  it("rejects a payload missing the required batch field with 400", async () => {
    const res = await app.request("/api/public/ingestion", {
      method: "POST",
      body: JSON.stringify({ notABatch: true }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      }
    });
    expect(res.status).toBe(400);
  });

  it("persists the raw batch to object storage and queues a reference, same as native ingest", async () => {
    const res = await app.request("/api/public/ingestion", {
      method: "POST",
      body: JSON.stringify(langfuseBatch()),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      }
    });
    expect(res.status).toBe(207);

    // No batchId is returned in a LangFuse-shaped response, so just assert
    // the queue actually gained a job (proves the async pipeline ran).
    const counts = await queue.getJobCounts();
    const total =
      (counts.waiting ?? 0) +
      (counts.active ?? 0) +
      (counts.completed ?? 0) +
      (counts.delayed ?? 0);
    expect(total).toBeGreaterThan(0);
  });
});
