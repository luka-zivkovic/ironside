import { createClickHouseClient } from "@ironside/clickhouse";
import { runMigrations } from "@ironside/db";
import { createIngestQueue } from "@ironside/queue";
import { pendingIngestObjectKey, type IngestBatch } from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestMachineCredential } from "./helpers/machine-credential.js";

// Integration test of the fast-ACK edge against the live compose stack:
// auth -> validate -> raw batch lands in MinIO -> job lands in the queue.
// Worker-side processing is covered separately (M1-02).

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

const app = createApp({ pgPool: pool, clickhouse, redis, storage, queue, webOrigins: ["http://localhost:5174"], defaultRateLimitPerMinute: 10000 });

let apiKey: string;

beforeAll(async () => {
  await runMigrations(pool);
  await storage.ensureBucket();
  const orgId = `org_${ulid()}`;
  const projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "ingest-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, "ingest-test"]
  );
  apiKey = (await createTestMachineCredential(pool, projectId, "ingest-test", "ingest")).token;
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'ingest-test-org'");
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

function tracePayload() {
  return {
    events: [
      {
        type: "trace-upsert",
        body: {
          id: `trace_${ulid()}`,
          timestamp: new Date().toISOString(),
          name: "checkout",
          metadata: { source: "ingest-test" }
        }
      }
    ]
  };
}

describe("POST /api/v1/ingest", () => {
  it("rejects requests without a valid API key", async () => {
    const anon = await app.request("/api/v1/ingest", {
      method: "POST",
      body: JSON.stringify(tracePayload()),
      headers: { "content-type": "application/json" }
    });
    expect(anon.status).toBe(401);

    const bad = await app.request("/api/v1/ingest", {
      method: "POST",
      body: JSON.stringify(tracePayload()),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer ironside_sc_deadbeef"
      }
    });
    expect(bad.status).toBe(401);
  });

  it("rejects malformed payloads with 400 and issue details", async () => {
    const res = await app.request("/api/v1/ingest", {
      method: "POST",
      body: JSON.stringify({ events: [{ type: "nonsense", body: {} }] }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      }
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: unknown[] };
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("ACKs a valid batch, persists it raw to object storage, and queues a reference", async () => {
    const res = await app.request("/api/v1/ingest", {
      method: "POST",
      body: JSON.stringify(tracePayload()),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      }
    });
    expect(res.status).toBe(202);
    const { batchId, received } = (await res.json()) as {
      batchId: string;
      received: number;
    };
    expect(received).toBe(1);

    const job = await queue.getJob(batchId);
    expect(job).toBeDefined();
    expect(job?.data.batchId).toBe(batchId);

    const raw = (await storage.getJson(job!.data.objectKey)) as IngestBatch;
    expect(raw.batchId).toBe(batchId);
    expect(raw.events).toHaveLength(1);
    expect(raw.events[0]?.source).toBe("native");
    expect(raw.events[0]?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    // Server assigns ids to events that lack one.
    expect(raw.events[0]?.id).toBeTruthy();

    const pending = await storage.getJson(
      pendingIngestObjectKey(raw.batchId)
    );
    expect(pending).toEqual(job?.data);

    await storage.delete(
      pendingIngestObjectKey(raw.batchId)
    );
    await job?.remove();
  });
});
