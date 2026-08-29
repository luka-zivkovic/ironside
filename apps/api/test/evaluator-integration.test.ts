import {
  createClickHouseClient,
  insertObservations,
  insertTraces,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import {
  publishEvaluatorTraceActivities,
  runMigrations as runPgMigrations
} from "@ironside/db";
import { createIngestQueue } from "@ironside/queue";
import {
  EVALUATOR_PROTOCOL_VERSION,
  evaluatorContextResponseSchema,
  evaluatorTraceFeedResponseSchema,
  evaluatorTraceResponseSchema,
  type Observation,
  type Trace
} from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestMachineCredential } from "./helpers/machine-credential.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);
const app = createApp({
  pgPool: pool,
  clickhouse,
  redis,
  storage,
  queue,
  webOrigins: ["http://localhost:5174"],
  defaultRateLimitPerMinute: 10_000,
  defaultTraceQuietPeriodSeconds: 0
});

let organizationId: string;
let projectId: string;
let apiKey: string;
let trace: Trace;
const firstVersion = "2026-08-01T12:00:00.000Z";

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();
  organizationId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [organizationId, "evaluator integration"]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, organizationId, "Evaluator source project"]
  );
  apiKey = (await createTestMachineCredential(pool, projectId, "coeval", "integration")).token;
  trace = {
    id: `trace_${ulid()}`,
    projectId,
    timestamp: "2026-08-01T11:59:00.000Z",
    name: "support-turn",
    userId: "user_1",
    sessionId: "session_1",
    environment: "production",
    tags: ["support"],
    metadata: { plan: "pro" },
    input: { question: "Refund?" },
    output: { answer: "Within 30 days." }
  };
  await insertTraces(clickhouse, [trace], { eventTs: firstVersion });
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [organizationId]);
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

const headers = () => ({ authorization: `Bearer ${apiKey}` });

describe("native evaluator integration", () => {
  it("discovers project scope, bootstraps settled versions, follows reopen activity, and writes an idempotent assessment", async () => {
    const contextResponse = await app.request("/api/v1/evaluator/context", { headers: headers() });
    expect(contextResponse.status).toBe(200);
    expect(evaluatorContextResponseSchema.parse(await contextResponse.json())).toMatchObject({
      protocolVersion: EVALUATOR_PROTOCOL_VERSION,
      project: { id: projectId, name: "Evaluator source project" },
      capabilities: expect.arrayContaining(["traces:read", "scores:write"]),
      settlement: { kind: "quiet_period", quietPeriodSeconds: 0 }
    });

    const bootstrapResponse = await app.request("/api/v1/evaluator/traces?limit=10", { headers: headers() });
    expect(bootstrapResponse.status).toBe(200);
    const bootstrap = evaluatorTraceFeedResponseSchema.parse(await bootstrapResponse.json());
    expect(bootstrap).toMatchObject({
      protocolVersion: EVALUATOR_PROTOCOL_VERSION,
      hasMore: false,
      traces: [{ traceId: trace.id, traceVersion: firstVersion }]
    });

    const detailResponse = await app.request(
      `/api/v1/evaluator/traces/${trace.id}?version=${encodeURIComponent(firstVersion)}`,
      { headers: headers() }
    );
    expect(detailResponse.status).toBe(200);
    expect(evaluatorTraceResponseSchema.parse(await detailResponse.json())).toMatchObject({
      id: trace.id,
      traceVersion: firstVersion,
      input: { question: "Refund?" },
      output: { answer: "Within 30 days." },
      observations: []
    });

    // A worker-published activity is discoverable through the live cursor.
    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [trace.id],
      traceVersion: firstVersion
    });
    const liveResponse = await app.request(
      `/api/v1/evaluator/traces?limit=10&cursor=${encodeURIComponent(bootstrap.nextCursor)}`,
      { headers: headers() }
    );
    const live = evaluatorTraceFeedResponseSchema.parse(await liveResponse.json());
    expect(live.traces).toEqual([expect.objectContaining({ traceId: trace.id, traceVersion: firstVersion })]);

    const secondVersion = new Date().toISOString();
    const observation: Observation = {
      id: `obs_${ulid()}`,
      traceId: trace.id,
      projectId,
      type: "generation",
      name: "answer",
      startTime: trace.timestamp,
      level: "default",
      model: "gpt-5",
      input: { question: "Refund?" },
      output: { answer: "Within 30 days." },
      metadata: {}
    };
    await insertObservations(clickhouse, [observation], { eventTs: secondVersion });
    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [trace.id],
      traceVersion: secondVersion
    });

    const staleDetail = await app.request(
      `/api/v1/evaluator/traces/${trace.id}?version=${encodeURIComponent(firstVersion)}`,
      { headers: headers() }
    );
    expect(staleDetail.status).toBe(409);
    expect(await staleDetail.json()).toMatchObject({ code: "trace_version_changed" });

    const reopenedResponse = await app.request(
      `/api/v1/evaluator/traces?limit=10&cursor=${encodeURIComponent(live.nextCursor)}`,
      { headers: headers() }
    );
    const reopened = evaluatorTraceFeedResponseSchema.parse(await reopenedResponse.json());
    expect(reopened.traces).toEqual([expect.objectContaining({ traceId: trace.id, traceVersion: secondVersion })]);

    const versionedDetail = await app.request(
      `/api/v1/evaluator/traces/${trace.id}?version=${encodeURIComponent(secondVersion)}`,
      { headers: headers() }
    );
    expect(evaluatorTraceResponseSchema.parse(await versionedDetail.json()).observations)
      .toEqual([expect.objectContaining({ id: observation.id, children: [] })]);

    const scoreId = `score_${ulid()}`;
    const scoreResponse = await app.request("/api/v1/evaluator/scores", {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({
        id: scoreId,
        traceId: trace.id,
        name: "coeval_assessment/support-quality",
        value: 0.92,
        assessmentLabel: "pass",
        comment: "The response follows policy.",
        evaluator: {
          provider: "coeval",
          versionId: "skillv_1",
          criterionKey: "support-quality"
        }
      })
    });
    expect(scoreResponse.status).toBe(200);
    expect(await scoreResponse.json()).toEqual({ id: scoreId });
  });
});
