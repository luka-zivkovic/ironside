import {
  createClickHouseClient,
  insertObservations,
  insertTraces,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import { runMigrations as runPgMigrations } from "@ironside/db";
import { createIngestQueue } from "@ironside/queue";
import type { Observation, Trace, TraceSummary } from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestOwnerSession, ownerHeaders } from "./helpers/owner-session.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

const app = createApp({ pgPool: pool, clickhouse, redis, storage, queue, webOrigins: ["http://localhost:5174"], defaultRateLimitPerMinute: 10000 });

let projectId: string;
let ownerCookie: string;
const marker = `search_${ulid()}`;
const ids = {
  checkout: `trace_checkout_${ulid()}`,
  support: `trace_support_${ulid()}`,
  bare: `trace_bare_${ulid()}`,
  inFlight: `trace_inflight_${ulid()}`
};

function trace(id: string, overrides: Partial<Trace> = {}): Trace {
  return { id, projectId, timestamp: new Date().toISOString(), tags: [marker], metadata: {}, ...overrides };
}

function observation(traceId: string, name: string, overrides: Partial<Observation>): Observation {
  return {
    id: `obs_${name}_${ulid()}`,
    traceId,
    projectId,
    type: "span",
    name,
    startTime: "2026-09-24T10:00:00.000Z",
    level: "default",
    metadata: {},
    ...overrides
  };
}

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();
  const owner = await createTestOwnerSession(pool);
  ownerCookie = owner.cookie;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
    projectId,
    owner.organizationId,
    "trace-search-test"
  ]);

  const eventTs = new Date().toISOString();
  await insertTraces(
    clickhouse,
    [
      trace(ids.checkout, { name: "Checkout flow", input: { question: "Where is my REFUND?" } }),
      trace(ids.support, { name: "support" }),
      trace(ids.bare),
      trace(ids.inFlight, { name: "still running" })
    ],
    { eventTs }
  );
  await insertObservations(
    clickhouse,
    [
      observation(ids.checkout, "llm-call", {
        type: "generation",
        model: "gpt-4o",
        endTime: "2026-09-24T10:00:02.500Z",
        usageDetails: { input_tokens: 100, output_tokens: 50 },
        costDetails: { input: 0.1, output: 0.2, total: 0.3 }
      }),
      observation(ids.checkout, "charge-card", {
        level: "error",
        startTime: "2026-09-24T10:00:00.500Z",
        endTime: "2026-09-24T10:00:03.000Z",
        output: "Card declined",
        // No total: the components are summed.
        costDetails: { input: 0.05, output: 0.05 }
      }),
      observation(ids.support, "answer", {
        type: "generation",
        model: "claude-sonnet-5",
        endTime: "2026-09-24T10:00:00.200Z",
        output: { text: "Your refund was issued" },
        // A reported total wins over the components and cache keys.
        usageDetails: { input_tokens: 30, output_tokens: 10, total_tokens: 40, cache_read_input_tokens: 999 },
        costDetails: { total: 0.01 }
      }),
      observation(ids.inFlight, "waiting", { level: "warning" })
    ],
    { eventTs }
  );
});

afterAll(async () => {
  await pool.query("delete from projects where id = $1", [projectId]);
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

async function get(path: string): Promise<Response> {
  return app.request(`/api/v1/projects/${projectId}${path}`, { headers: ownerHeaders(ownerCookie) });
}

/** Lists the marked traces under `filters`, and checks the aggregates count the same set. */
async function listIds(filters: string): Promise<string[]> {
  const list = await get(`/traces?tags=${marker}&limit=100&${filters}`);
  expect(list.status).toBe(200);
  const listed = ((await list.json()) as { traces: TraceSummary[] }).traces.map((row) => row.id);

  const aggregates = await get(`/traces/aggregates?tags=${marker}&${filters}`);
  expect(aggregates.status).toBe(200);
  expect(((await aggregates.json()) as { traceCount: number }).traceCount).toBe(listed.length);
  return listed.sort();
}

describe("GET /traces — per-trace figures", () => {
  it("returns each trace's duration, cost, tokens, error count and models", async () => {
    const res = await get(`/traces?tags=${marker}&limit=100`);
    const traces = ((await res.json()) as { traces: TraceSummary[] }).traces;
    const byId = new Map(traces.map((row) => [row.id, row]));

    expect(byId.get(ids.checkout)).toMatchObject({
      durationMs: 3000,
      totalCost: expect.closeTo(0.4, 9),
      totalTokens: 150,
      errorCount: 1,
      models: ["gpt-4o"]
    });
    expect(byId.get(ids.support)).toMatchObject({
      durationMs: 200,
      totalCost: expect.closeTo(0.01, 9),
      totalTokens: 40,
      errorCount: 0,
      models: ["claude-sonnet-5"]
    });
    expect(byId.get(ids.bare)).toMatchObject({
      durationMs: null,
      totalCost: null,
      totalTokens: null,
      errorCount: 0,
      models: []
    });
    expect(byId.get(ids.inFlight)).toMatchObject({ durationMs: null, totalCost: null, totalTokens: null });
  });
});

describe("GET /traces — search and filters", () => {
  it("searches trace and observation names, inputs and outputs case-insensitively", async () => {
    expect(await listIds("search=refund")).toEqual([ids.checkout, ids.support].sort());
    expect(await listIds("search=declined")).toEqual([ids.checkout]);
    expect(await listIds("search=CHECKOUT%20FLOW")).toEqual([ids.checkout]);
    expect(await listIds("search=charge-card")).toEqual([ids.checkout]);
    expect(await listIds("search=no-such-text")).toEqual([]);
  });

  it("matches a trace id exactly, not by prefix", async () => {
    expect(await listIds(`search=${ids.bare}`)).toEqual([ids.bare]);
    expect(await listIds(`search=${ids.bare.slice(0, -4)}`)).toEqual([]);
  });

  it("filters by observation level and model", async () => {
    expect(await listIds("level=error")).toEqual([ids.checkout]);
    expect(await listIds("level=warning")).toEqual([ids.inFlight]);
    expect(await listIds("model=claude-sonnet-5")).toEqual([ids.support]);
    expect(await listIds("model=gpt-4")).toEqual([]);
  });

  it("filters by minimum duration, leaving out traces with no ended observation", async () => {
    expect(await listIds("minDurationMs=1000")).toEqual([ids.checkout]);
    expect(await listIds("minDurationMs=0")).toEqual([ids.checkout, ids.support].sort());
  });

  it("filters by minimum cost, counting an observation without a total as the sum of its components", async () => {
    // The checkout trace costs 0.3 + (0.05 + 0.05).
    expect(await listIds("minCost=0.35")).toEqual([ids.checkout]);
    expect(await listIds("minCost=0.005")).toEqual([ids.checkout, ids.support].sort());
  });

  it("combines filters", async () => {
    expect(await listIds("search=refund&level=error")).toEqual([ids.checkout]);
    expect(await listIds("search=refund&minCost=1")).toEqual([]);
  });

  it("treats an empty value as an unset filter", async () => {
    expect(await listIds("search=&model=&minDurationMs=&minCost=")).toEqual(Object.values(ids).sort());
  });

  it("rejects invalid filter values", async () => {
    for (const query of [
      "level=fatal",
      "minCost=-1",
      "minCost=cheap",
      "minDurationMs=1.5",
      `search=${"x".repeat(201)}`
    ]) {
      expect((await get(`/traces?${query}`)).status, query).toBe(400);
      expect((await get(`/traces/aggregates?${query}`)).status, query).toBe(400);
    }
  });
});
