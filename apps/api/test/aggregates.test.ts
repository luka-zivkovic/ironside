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
    [projectId, orgId, "aggregates-test"]
  );
  apiKey = (await createTestMachineCredential(pool, projectId, "aggregates-test", "integration")).token;
});

afterAll(async () => {
  await pool.query("delete from projects where id = $1", [projectId]);
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

describe("GET /api/v1/traces/aggregates", () => {
  it("returns zeroed/null aggregates for a project with no matching traces", async () => {
    const res = await get("/api/v1/traces/aggregates?userId=__nobody_matches_this__");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      traceCount: number;
      tokenTotals: Record<string, number>;
      costTotals: Record<string, number>;
      latencyMsPercentiles: { p50: number | null; p95: number | null; p99: number | null };
    };
    expect(body.traceCount).toBe(0);
    expect(body.tokenTotals).toEqual({});
    expect(body.latencyMsPercentiles).toEqual({ p50: null, p95: null, p99: null });
  });

  it("counts traces, sums tokens/cost from observations, and computes latency percentiles", async () => {
    const marker = `agg_${ulid()}`;
    const eventTs = new Date().toISOString();

    const traces: Trace[] = [1, 2, 3].map((i) => ({
      id: `trace_${marker}_${i}`,
      projectId,
      timestamp: new Date().toISOString(),
      tags: [marker],
      metadata: {}
    }));
    await insertTraces(clickhouse, traces, { eventTs });

    // Trace 1: one generation, 1000ms duration, known usage/cost.
    // Trace 2: one generation, 2000ms duration, known usage/cost.
    // Trace 3: no observations at all (must not contribute a 0ms latency
    // sample or be excluded from traceCount).
    const observations: Observation[] = [
      {
        id: `obs_${marker}_1`,
        traceId: traces[0]!.id,
        projectId,
        type: "generation",
        startTime: "2026-07-12T00:00:00.000Z",
        endTime: "2026-07-12T00:00:01.000Z",
        usageDetails: { input_tokens: 10, output_tokens: 20 },
        costDetails: { total: 0.5 },
        level: "default",
        metadata: {}
      },
      {
        id: `obs_${marker}_2`,
        traceId: traces[1]!.id,
        projectId,
        type: "generation",
        startTime: "2026-07-12T00:00:00.000Z",
        endTime: "2026-07-12T00:00:02.000Z",
        usageDetails: { input_tokens: 5, output_tokens: 15 },
        costDetails: { total: 0.25 },
        level: "default",
        metadata: {}
      }
    ];
    await insertObservations(clickhouse, observations, { eventTs });

    const res = await get(`/api/v1/traces/aggregates?tags=${marker}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      traceCount: number;
      tokenTotals: Record<string, number>;
      costTotals: Record<string, number>;
      latencyMsPercentiles: { p50: number | null; p95: number | null; p99: number | null };
    };

    expect(body.traceCount).toBe(3);
    expect(body.tokenTotals).toEqual({ input_tokens: 15, output_tokens: 35 });
    expect(body.costTotals).toEqual({ total: 0.75 });
    // Only 2 latency samples (1000ms, 2000ms) — trace 3 contributes none.
    expect(body.latencyMsPercentiles.p50).toBeGreaterThan(0);
    expect(body.latencyMsPercentiles.p99).toBeLessThanOrEqual(2000);
  });

  it("only aggregates the authenticated project's traces", async () => {
    const orgId = `org_${ulid()}`;
    const otherProjectId = `proj_${ulid()}`;
    await pool.query("insert into organizations (id, name) values ($1, $2)", [
      orgId,
      "aggregates-test-other-org"
    ]);
    await pool.query(
      "insert into projects (id, organization_id, name) values ($1, $2, $3)",
      [otherProjectId, orgId, "aggregates-test-other"]
    );
    const marker = `isolation_${ulid()}`;
    await insertTraces(
      clickhouse,
      [
        {
          id: `trace_${marker}`,
          projectId: otherProjectId,
          timestamp: new Date().toISOString(),
          tags: [marker],
          metadata: {}
        }
      ],
      { eventTs: new Date().toISOString() }
    );

    const res = await get(`/api/v1/traces/aggregates?tags=${marker}`);
    const body = (await res.json()) as { traceCount: number };
    expect(body.traceCount).toBe(0);

    await pool.query("delete from organizations where name = 'aggregates-test-other-org'");
  });

  it("rejects requests without a valid API key", async () => {
    const res = await app.request(`/api/v1/projects/${projectId}/traces/aggregates`);
    expect(res.status).toBe(401);
  });
});
