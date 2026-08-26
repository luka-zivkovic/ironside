import {
  createClickHouseClient,
  insertObservations,
  insertTraces,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import { runMigrations as runPgMigrations } from "@ironside/db";
import { createIngestQueue } from "@ironside/queue";
import type { Observation, Trace } from "@ironside/shared";
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

const app = createApp({ pgPool: pool, clickhouse, redis, storage, queue, webOrigins: ["http://localhost:5174"], defaultRateLimitPerMinute: 10000 });

let apiKey: string;
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
    [projectId, orgId, "trace-detail-test", otherProjectId, "trace-detail-test-other"]
  );
  apiKey = (await createTestMachineCredential(pool, projectId, "trace-detail-test", "integration")).token;
});

afterAll(async () => {
  await pool.query("delete from projects where id = any($1)", [[projectId, otherProjectId]]);
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

async function get(path: string) {
  return app.request(path.replace("/api/v1/traces", `/api/v1/projects/${projectId}/traces`), {
    headers: ownerHeaders(ownerCookie)
  });
}

describe("GET /api/v1/traces/:id", () => {
  it("returns 404 for a trace that does not exist", async () => {
    const res = await get("/api/v1/traces/does_not_exist");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a trace belonging to another project (no cross-tenant leak)", async () => {
    const theirTraceId = `trace_${ulid()}`;
    const theirs: Trace = {
      id: theirTraceId,
      projectId: otherProjectId,
      timestamp: new Date().toISOString(),
      tags: [],
      metadata: {}
    };
    await insertTraces(clickhouse, [theirs], { eventTs: new Date().toISOString() });

    const res = await get(`/api/v1/traces/${theirTraceId}`);
    expect(res.status).toBe(404);
  });

  it("returns the trace with its observations nested into a tree", async () => {
    const traceId = `trace_${ulid()}`;
    const trace: Trace = {
      id: traceId,
      projectId,
      timestamp: new Date().toISOString(),
      name: "checkout",
      tags: ["prod"],
      metadata: { plan: "pro" },
      input: { cart: ["sku_1"] },
      output: { total: 42 }
    };

    const rootId = `obs_${ulid()}`;
    const childId = `obs_${ulid()}`;
    const root: Observation = {
      id: rootId,
      traceId,
      projectId,
      type: "span",
      name: "handle-request",
      startTime: "2026-07-12T00:00:00.000Z",
      level: "default",
      metadata: {}
    };
    const child: Observation = {
      id: childId,
      traceId,
      projectId,
      parentObservationId: rootId,
      type: "generation",
      name: "llm-call",
      startTime: "2026-07-12T00:00:01.000Z",
      model: "claude-x",
      usageDetails: { input_tokens: 10, output_tokens: 20 },
      level: "default",
      metadata: {}
    };

    await insertTraces(clickhouse, [trace], { eventTs: new Date().toISOString() });
    await insertObservations(clickhouse, [root, child], { eventTs: new Date().toISOString() });

    const res = await get(`/api/v1/traces/${traceId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      name: string;
      input: unknown;
      output: unknown;
      observations: {
        id: string;
        children: {
          id: string;
          model: string;
          usageDetails: Record<string, number>;
        }[];
      }[];
    };

    expect(body.id).toBe(traceId);
    expect(body.name).toBe("checkout");
    expect(body.input).toEqual({ cart: ["sku_1"] });
    expect(body.output).toEqual({ total: 42 });
    expect(body.observations).toHaveLength(1);
    expect(body.observations[0]?.id).toBe(rootId);
    expect(body.observations[0]?.children).toHaveLength(1);
    expect(body.observations[0]?.children[0]?.id).toBe(childId);
    expect(body.observations[0]?.children[0]?.model).toBe("claude-x");
    // usageDetails values must be numbers, not ClickHouse UInt64-as-string
    // (regression: apps/api/test/contract.test.ts caught this once already).
    expect(body.observations[0]?.children[0]?.usageDetails).toEqual({
      input_tokens: 10,
      output_tokens: 20
    });
  });

  it("rejects requests without a valid API key", async () => {
    const res = await app.request(`/api/v1/projects/${projectId}/traces/whatever`);
    expect(res.status).toBe(401);
  });
});
