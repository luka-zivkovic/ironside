import {
  createClickHouseClient,
  insertObservations,
  insertTraces,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import { runMigrations as runPgMigrations } from "@ironside/db";
import { createIngestQueue } from "@ironside/queue";
import {
  aggregatesResponseSchema,
  listTracesResponseSchema,
  traceTreeResponseSchema
} from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { buildQueryApiFixture, type QueryApiFixture } from "./fixtures/query-api.js";
import { createTestOwnerSession, ownerHeaders } from "./helpers/owner-session.js";

// M2 contract tests: one seeded fixture shared across list/tree/aggregates
// so results can be cross-checked against each other, and every response is
// validated against its published Zod schema (packages/shared/src/query.ts)
// — catching response-shape drift, not just spot-checked field values.

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

const app = createApp({ pgPool: pool, clickhouse, redis, storage, queue, webOrigins: ["http://localhost:5174"], defaultRateLimitPerMinute: 10000 });

let projectId: string;
let fixture: QueryApiFixture;
let ownerCookie: string;

async function get(path: string) {
  return app.request(path.replace("/api/v1/traces", `/api/v1/projects/${projectId}/traces`), {
    headers: ownerHeaders(ownerCookie)
  });
}

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();
  const owner = await createTestOwnerSession(pool);
  const orgId = owner.organizationId;
  ownerCookie = owner.cookie;
  projectId = `proj_${ulid()}`;
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, "contract-test"]
  );
  fixture = buildQueryApiFixture(projectId);
  const eventTs = new Date().toISOString();
  await insertTraces(clickhouse, fixture.traces, { eventTs });
  await insertObservations(clickhouse, fixture.observations, { eventTs });
});

afterAll(async () => {
  await pool.query("delete from projects where id = $1", [projectId]);
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

describe("GET /api/v1/traces — contract", () => {
  it("response matches listTracesResponseSchema and includes both fixture traces", async () => {
    const res = await get(`/api/v1/traces?tags=${fixture.marker}&limit=100`);
    expect(res.status).toBe(200);
    const parseResult = listTracesResponseSchema.safeParse(await res.json());
    expect(
      parseResult.success,
      JSON.stringify(parseResult.success ? null : parseResult.error.issues)
    ).toBe(true);
    if (!parseResult.success) return;
    const body = parseResult.data;

    const ids = body.traces.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([fixture.richTraceId, fixture.bareTraceId])
    );

    const rich = body.traces.find((t) => t.id === fixture.richTraceId);
    expect(rich).toMatchObject({
      id: fixture.richTraceId,
      name: "checkout",
      userId: "user_contract_1",
      sessionId: "sess_contract_1",
      tags: expect.arrayContaining(["prod", fixture.marker]),
      metadata: { plan: "enterprise" }
    });
  });
});

describe("GET /api/v1/traces/:id — contract", () => {
  it("response matches traceTreeResponseSchema with correctly nested observations", async () => {
    const res = await get(`/api/v1/traces/${fixture.richTraceId}`);
    expect(res.status).toBe(200);
    const parseResult = traceTreeResponseSchema.safeParse(await res.json());
    expect(
      parseResult.success,
      JSON.stringify(parseResult.success ? null : parseResult.error.issues)
    ).toBe(true);
    if (!parseResult.success) return;
    const body = parseResult.data;

    expect(body.input).toEqual({ cart: ["sku_1"] });
    expect(body.output).toEqual({ total: 42 });
    expect(body.observations).toHaveLength(1);
    expect(body.observations[0]?.name).toBe("handle-request");
    expect(body.observations[0]?.children).toHaveLength(1);
    expect(body.observations[0]?.children[0]).toMatchObject({
      name: "llm-call",
      model: "claude-contract-test",
      usageDetails: { input_tokens: 120, output_tokens: 340 }
    });
  });

  it("a trace with no observations still matches the schema with an empty tree", async () => {
    const res = await get(`/api/v1/traces/${fixture.bareTraceId}`);
    expect(res.status).toBe(200);
    const parseResult = traceTreeResponseSchema.safeParse(await res.json());
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;
    expect(parseResult.data.observations).toEqual([]);
  });
});

describe("GET /api/v1/traces/aggregates — contract", () => {
  it("response matches aggregatesResponseSchema and cross-checks against the tree endpoint", async () => {
    const res = await get(`/api/v1/traces/aggregates?tags=${fixture.marker}`);
    expect(res.status).toBe(200);
    const parseResult = aggregatesResponseSchema.safeParse(await res.json());
    expect(
      parseResult.success,
      JSON.stringify(parseResult.success ? null : parseResult.error.issues)
    ).toBe(true);
    if (!parseResult.success) return;
    const body = parseResult.data;

    // Cross-check: the fixture has exactly 2 traces tagged with the marker.
    expect(body.traceCount).toBe(2);
    // Cross-check: token/cost totals must equal the sum from the one
    // observation in the fixture that carries usage/cost data (the other
    // observation and the bare trace contribute nothing).
    expect(body.tokenTotals).toEqual({ input_tokens: 120, output_tokens: 340 });
    expect(body.costTotals).toEqual({ total: 2.5 });
    // Cross-check: latency is min(start_time)..max(end_time) across ALL of
    // a trace's observations, not just one. For the rich trace that's
    // min(T+0ms [root], T+200ms [child]) ..
    // max(T+1500ms [root], T+1400ms [child]) = 1500ms, driven by
    // the root's span here (both bounds happen to come from it) but not
    // because the child is excluded. The bare trace contributes no sample
    // (no observations), so this one trace's 1500ms determines every
    // percentile.
    expect(body.latencyMsPercentiles.p50).toBe(1500);
    expect(body.latencyMsPercentiles.p95).toBe(1500);
    expect(body.latencyMsPercentiles.p99).toBe(1500);
  });
});
