import {
  createClickHouseClient,
  insertRawEventRefs,
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
      sourceActivityAt: firstVersion,
      activityId: "batch_first"
    });
    const liveResponse = await app.request(
      `/api/v1/evaluator/traces?limit=10&cursor=${encodeURIComponent(bootstrap.nextCursor)}`,
      { headers: headers() }
    );
    const live = evaluatorTraceFeedResponseSchema.parse(await liveResponse.json());
    expect(live.traces).toEqual([expect.objectContaining({ traceId: trace.id })]);
    const liveVersion = live.traces[0]!.traceVersion;
    expect(liveVersion).not.toBe(firstVersion);

    // Publication precedes final raw-ref acknowledgement. The feed must keep
    // its cursor before the pending snapshot, then expose that same version
    // once materialization is fully acknowledged.
    const pendingTrace: Trace = {
      ...trace,
      id: `trace_${ulid()}`,
      name: "pending-materialization"
    };
    const pendingAt = new Date().toISOString();
    const pendingRef = {
      projectId,
      traceId: pendingTrace.id,
      objectKey: `raw/${ulid()}.json`,
      receivedAt: pendingAt
    };
    await insertTraces(clickhouse, [pendingTrace], { eventTs: pendingAt });
    await insertRawEventRefs(clickhouse, [pendingRef], pendingAt, false);
    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [pendingTrace.id],
      sourceActivityAt: pendingAt,
      activityId: "batch_pending"
    });
    const pendingResponse = await app.request(
      `/api/v1/evaluator/traces?limit=10&cursor=${encodeURIComponent(live.nextCursor)}`,
      { headers: headers() }
    );
    const pending = evaluatorTraceFeedResponseSchema.parse(await pendingResponse.json());
    expect(pending).toMatchObject({ traces: [], hasMore: false, nextCursor: live.nextCursor });
    await insertRawEventRefs(clickhouse, [pendingRef], pendingAt, true);
    const appliedResponse = await app.request(
      `/api/v1/evaluator/traces?limit=10&cursor=${encodeURIComponent(live.nextCursor)}`,
      { headers: headers() }
    );
    const applied = evaluatorTraceFeedResponseSchema.parse(await appliedResponse.json());
    expect(applied.traces).toEqual([
      expect.objectContaining({ traceId: pendingTrace.id })
    ]);

    // Retrying the same durable batch does not mint another snapshot version.
    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [trace.id],
      sourceActivityAt: firstVersion,
      activityId: "batch_first"
    });
    const quiescentResponse = await app.request(
      `/api/v1/evaluator/traces?limit=1&cursor=${encodeURIComponent(applied.nextCursor)}`,
      { headers: headers() }
    );
    const quiescent = evaluatorTraceFeedResponseSchema.parse(await quiescentResponse.json());
    expect(quiescent).toMatchObject({ traces: [], hasMore: false });

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
      sourceActivityAt: secondVersion,
      activityId: "batch_second"
    });

    const staleDetail = await app.request(
      `/api/v1/evaluator/traces/${trace.id}?version=${encodeURIComponent(liveVersion)}`,
      { headers: headers() }
    );
    expect(staleDetail.status).toBe(409);
    expect(await staleDetail.json()).toMatchObject({ code: "trace_version_changed" });

    const reopenedResponse = await app.request(
      `/api/v1/evaluator/traces?limit=10&cursor=${encodeURIComponent(applied.nextCursor)}`,
      { headers: headers() }
    );
    const reopened = evaluatorTraceFeedResponseSchema.parse(await reopenedResponse.json());
    expect(reopened.traces).toEqual([expect.objectContaining({ traceId: trace.id })]);
    const reopenedVersion = reopened.traces[0]!.traceVersion;
    expect(reopenedVersion).not.toBe(liveVersion);

    const versionedDetail = await app.request(
      `/api/v1/evaluator/traces/${trace.id}?version=${encodeURIComponent(reopenedVersion)}`,
      { headers: headers() }
    );
    expect(evaluatorTraceResponseSchema.parse(await versionedDetail.json()).observations)
      .toEqual([expect.objectContaining({ id: observation.id, children: [] })]);

    // A late older batch still changes the materialized tree and therefore
    // publishes a fresh snapshot version while retaining the newer source
    // activity as the settlement watermark.
    const lateObservation: Observation = {
      ...observation,
      id: `obs_${ulid()}`,
      name: "late-older-batch"
    };
    await insertObservations(clickhouse, [lateObservation], { eventTs: firstVersion });
    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [trace.id],
      sourceActivityAt: firstVersion,
      activityId: "batch_late_older"
    });
    const lateResponse = await app.request(
      `/api/v1/evaluator/traces?limit=10&cursor=${encodeURIComponent(reopened.nextCursor)}`,
      { headers: headers() }
    );
    const late = evaluatorTraceFeedResponseSchema.parse(await lateResponse.json());
    expect(late.traces).toHaveLength(1);
    expect(late.traces[0]!.traceVersion).not.toBe(reopenedVersion);
    const lateDetail = await app.request(
      `/api/v1/evaluator/traces/${trace.id}?version=${encodeURIComponent(late.traces[0]!.traceVersion)}`,
      { headers: headers() }
    );
    expect(evaluatorTraceResponseSchema.parse(await lateDetail.json()).observations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: lateObservation.id })]));

    // A full page of retention orphans must still advertise another page;
    // otherwise a consumer can mistake the empty payload for quiescence.
    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [`trace_missing_${ulid()}`, `trace_missing_${ulid()}`],
      sourceActivityAt: firstVersion,
      activityId: "batch_missing_traces"
    });
    const orphanResponse = await app.request(
      `/api/v1/evaluator/traces?limit=1&cursor=${encodeURIComponent(late.nextCursor)}`,
      { headers: headers() }
    );
    expect(evaluatorTraceFeedResponseSchema.parse(await orphanResponse.json()))
      .toMatchObject({ traces: [], hasMore: true });

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
