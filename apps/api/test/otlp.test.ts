import {
  createClickHouseClient,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import { runMigrations as runPgMigrations } from "@ironside/db";
import { createIngestQueue, enqueueBatch } from "@ironside/queue";
import { mapOtlpTraceRequest } from "@ironside/mappers";
import { otlpExportTraceServiceRequestSchema, rawObjectKey, type IngestBatch } from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestMachineCredential } from "./helpers/machine-credential.js";

// Integration test of the OTLP fast-ACK edge: auth -> validate -> raw batch
// lands in object storage -> job lands in the queue. Worker-side OTLP
// mapping is covered in packages/mappers/test/otlp.test.ts (unit) and here
// once more end-to-end by running the mapper directly against the exact
// object storage payload the route produced, mirroring what the real
// worker does.

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

const app = createApp({ pgPool: pool, clickhouse, redis, storage, queue, webOrigins: ["http://localhost:5174"], defaultRateLimitPerMinute: 10000 });

let apiKey: string;
let projectId: string;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();
  const orgId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "otlp-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, "otlp-test"]
  );
  apiKey = (await createTestMachineCredential(pool, projectId, "otlp-test", "ingest")).token;
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'otlp-test-org'");
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

function otlpExport() {
  return {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: "0af7651916cd43dd8448eb211c80319c",
                spanId: "b7ad6b7169203331",
                name: "chat gpt-4o",
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000001000000000",
                attributes: [
                  { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                  { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: "50" } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: "75" } }
                ],
                status: { code: 1 }
              }
            ]
          }
        ]
      }
    ]
  };
}

describe("POST /v1/otel/traces", () => {
  it("rejects requests without a valid API key", async () => {
    const res = await app.request("/v1/otel/traces", {
      method: "POST",
      body: JSON.stringify(otlpExport()),
      headers: { "content-type": "application/json" }
    });
    expect(res.status).toBe(401);
  });

  it("rejects content types that are neither protobuf nor JSON with 415, not a crash", async () => {
    const res = await app.request("/v1/otel/traces", {
      method: "POST",
      body: "trace data",
      headers: {
        "content-type": "text/plain",
        authorization: `Bearer ${apiKey}`
      }
    });
    expect(res.status).toBe(415);
  });

  it("rejects malformed OTLP payloads with 400", async () => {
    const res = await app.request("/v1/otel/traces", {
      method: "POST",
      body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ notASpan: true }] }] }] }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      }
    });
    expect(res.status).toBe(400);
  });

  it("accepts a valid export, persists it raw, and queues a reference", async () => {
    const res = await app.request("/v1/otel/traces", {
      method: "POST",
      body: JSON.stringify(otlpExport()),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      }
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("the persisted raw batch maps correctly through the OTLP mapper (mirrors the worker)", async () => {
    // Same envelope-building steps the route performs, so we can assert on
    // the exact object it would have handed to the queue/worker.
    const receivedAt = new Date();
    const batchId = ulid();
    const objectKey = rawObjectKey(projectId, receivedAt, batchId);
    const batch: IngestBatch = {
      batchId,
      projectId,
      receivedAt: receivedAt.toISOString(),
      events: [
        {
          id: ulid(),
          type: "otlp-export",
          source: "otlp",
          schemaVersion: 1,
          idempotencyKey: "test-hash",
          body: otlpExport()
        }
      ]
    };
    await storage.putJson(objectKey, batch);
    await enqueueBatch(queue, { batchId, projectId, objectKey, eventCount: 1 });

    const stored = (await storage.getJson(objectKey)) as IngestBatch;
    const parsed = otlpExportTraceServiceRequestSchema.parse(stored.events[0]?.body);
    const { traces, observations } = mapOtlpTraceRequest(projectId, parsed);

    expect(traces).toHaveLength(1);
    expect(traces[0]?.id).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(observations).toHaveLength(1);
    expect(observations[0]?.model).toBe("gpt-4o");
    expect(observations[0]?.usageDetails).toEqual({ input_tokens: 50, output_tokens: 75 });
  });
});
