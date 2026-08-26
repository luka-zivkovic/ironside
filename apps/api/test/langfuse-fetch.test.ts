import {
  createClickHouseClient,
  insertObservations,
  insertScores,
  insertTraces,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import { runMigrations as runPgMigrations } from "@ironside/db";
import { createIngestQueue } from "@ironside/queue";
import { scoreSchema, type IngestBatch, type Observation, type Score, type Trace } from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestMachineCredential } from "./helpers/machine-credential.js";

// Integration tests for the LangFuse-shaped fetch API (M8): the read
// endpoints coeval's poller consumes (GET /api/public/traces,
// GET /api/public/traces/:id) and the verdict sync-back write endpoint
// (POST /api/public/scores). Runs against the real local stack, same as
// the other route tests.

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
  defaultRateLimitPerMinute: 10000,
  // Existing compatibility fixtures are inserted and read immediately;
  // dedicated finalization tests below cover a non-zero quiet period.
  defaultTraceQuietPeriodSeconds: 0
});

let apiKey: string;
let projectId: string;
let otherProjectId: string;
let otherApiKey: string;

// Fixed, well-spread timestamps so orderBy/page assertions are deterministic.
const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-02T00:00:00.000Z";
const T2 = "2026-07-03T00:00:00.000Z";

let traceA: Trace;
let traceB: Trace;
let traceC: Trace;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();
  const orgId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  otherProjectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "langfuse-fetch-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3), ($4, $2, $5)",
    [projectId, orgId, "langfuse-fetch-test", otherProjectId, "langfuse-fetch-test-other"]
  );
  apiKey = (await createTestMachineCredential(pool, projectId, "langfuse-fetch-test", "integration")).token;
  otherApiKey = (await createTestMachineCredential(pool, otherProjectId, "langfuse-fetch-test-other", "integration")).token;

  traceA = {
    id: `trace_${ulid()}`,
    projectId,
    timestamp: T0,
    name: "checkout",
    userId: "user_1",
    sessionId: "sess_1",
    environment: "production",
    release: "1.2.0",
    version: "abc",
    tags: ["prod"],
    metadata: { plan: "pro" },
    input: { question: "hi" },
    output: { answer: "hello" }
  };
  traceB = { id: `trace_${ulid()}`, projectId, timestamp: T1, tags: [], metadata: {} };
  traceC = { id: `trace_${ulid()}`, projectId, timestamp: T2, userId: "user_2", tags: [], metadata: {} };
  const foreign: Trace = {
    id: `trace_${ulid()}`,
    projectId: otherProjectId,
    timestamp: T1,
    tags: [],
    metadata: {}
  };
  await insertTraces(clickhouse, [traceA, traceB, traceC, foreign], {
    eventTs: new Date().toISOString()
  });

  const generation: Observation = {
    id: `obs_${ulid()}`,
    traceId: traceA.id,
    projectId,
    type: "generation",
    name: "llm-call",
    startTime: T0,
    endTime: "2026-07-01T00:00:02.000Z",
    completionStartTime: "2026-07-01T00:00:01.000Z",
    level: "error",
    statusMessage: "rate limited",
    model: "gpt-4o",
    modelParameters: { temperature: "0.7", max_tokens: "512" },
    input: { messages: [] },
    output: null,
    usageDetails: { input_tokens: 10, output_tokens: 5 },
    costDetails: { total: 0.0012 },
    metadata: {}
  };
  await insertObservations(clickhouse, [generation], { eventTs: new Date().toISOString() });

  const score: Score = {
    id: `score_${ulid()}`,
    projectId,
    traceId: traceA.id,
    name: "quality",
    dataType: "numeric",
    value: 0.5,
    source: "eval",
    comment: "solid",
    timestamp: T0,
    metadata: {}
  };
  await insertScores(clickhouse, [score], { eventTs: new Date().toISOString() });
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'langfuse-fetch-test-org'");
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

function basicAuth(key: string): string {
  // LangFuse clients send Basic base64(publicKey:secretKey); the secret
  // slot carries the real Ironside key.
  return `Basic ${Buffer.from(`pk_whatever:${key}`).toString("base64")}`;
}

async function get(path: string, key = apiKey) {
  return app.request(path, { headers: { authorization: basicAuth(key) } });
}

interface ListResponse {
  data: {
    id: string;
    timestamp: string;
    name: string | null;
    userId: string | null;
    sessionId: string | null;
    environment: string | null;
    release: string | null;
    version: string | null;
    tags: string[];
    metadata: Record<string, string>;
    input: unknown;
    output: unknown;
  }[];
  meta: { page: number; limit: number; totalItems: number; totalPages: number };
}

describe("GET /api/public/traces (LangFuse-shaped list)", () => {
  it("rejects requests without a valid key", async () => {
    const res = await app.request("/api/public/traces");
    expect(res.status).toBe(401);
  });

  it("returns {data, meta} with full trace payloads, newest-first by default", async () => {
    const res = await get("/api/public/traces?limit=100");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;

    expect(body.meta).toEqual({ page: 1, limit: 100, totalItems: 3, totalPages: 1 });
    expect(body.data.map((t) => t.id)).toEqual([traceC.id, traceB.id, traceA.id]);

    const a = body.data.find((t) => t.id === traceA.id);
    expect(a).toMatchObject({
      name: "checkout",
      userId: "user_1",
      sessionId: "sess_1",
      environment: "production",
      release: "1.2.0",
      version: "abc",
      tags: ["prod"],
      metadata: { plan: "pro" },
      input: { question: "hi" },
      output: { answer: "hello" }
    });
  });

  it("supports orderBy=timestamp.asc (what Ironside's own LangFuse importer requests)", async () => {
    const res = await get("/api/public/traces?limit=100&orderBy=timestamp.asc");
    const body = (await res.json()) as ListResponse;
    expect(body.data.map((t) => t.id)).toEqual([traceA.id, traceB.id, traceC.id]);
  });

  it("paginates by page/limit with a correct totalPages", async () => {
    const page1 = (await (await get("/api/public/traces?limit=2&page=1&orderBy=timestamp.asc")).json()) as ListResponse;
    const page2 = (await (await get("/api/public/traces?limit=2&page=2&orderBy=timestamp.asc")).json()) as ListResponse;

    expect(page1.meta).toEqual({ page: 1, limit: 2, totalItems: 3, totalPages: 2 });
    expect(page1.data.map((t) => t.id)).toEqual([traceA.id, traceB.id]);
    expect(page2.data.map((t) => t.id)).toEqual([traceC.id]);
  });

  it("filters by userId and fromTimestamp", async () => {
    const byUser = (await (await get("/api/public/traces?userId=user_2&limit=100")).json()) as ListResponse;
    expect(byUser.data.map((t) => t.id)).toEqual([traceC.id]);
    expect(byUser.meta.totalItems).toBe(1);

    const from = (await (
      await get(`/api/public/traces?fromTimestamp=${encodeURIComponent(T1)}&limit=100&orderBy=timestamp.asc`)
    ).json()) as ListResponse;
    expect(from.data.map((t) => t.id)).toEqual([traceB.id, traceC.id]);
  });

  it("only returns the authenticated project's traces", async () => {
    const res = await get("/api/public/traces?limit=100", otherApiKey);
    const body = (await res.json()) as ListResponse;
    expect(body.meta.totalItems).toBe(1);
    expect(body.data.map((t) => t.id)).not.toContain(traceA.id);
  });

  it("rejects an invalid orderBy with 400", async () => {
    const res = await get("/api/public/traces?orderBy=name.asc");
    expect(res.status).toBe(400);
  });

  it("hides a newly active trace from compatibility consumers until the project's quiet period elapses", async () => {
    const freshTraceId = `trace_${ulid()}`;
    await insertTraces(
      clickhouse,
      [
        {
          id: freshTraceId,
          projectId,
          timestamp: new Date().toISOString(),
          tags: [],
          metadata: {}
        }
      ],
      { eventTs: new Date().toISOString() }
    );
    await pool.query(
      "update projects set trace_quiet_period_seconds = 300 where id = $1",
      [projectId]
    );

    try {
      const list = (await (
        await get("/api/public/traces?limit=100")
      ).json()) as ListResponse;
      expect(list.data.map((trace) => trace.id)).not.toContain(freshTraceId);

      const detail = await get(`/api/public/traces/${freshTraceId}`);
      expect(detail.status).toBe(404);
    } finally {
      await pool.query(
        "update projects set trace_quiet_period_seconds = null where id = $1",
        [projectId]
      );
    }
  });

  it("OMITS unset optional fields rather than emitting explicit nulls — regression: coeval's LangFuse trace schema is .optional() but not .nullable(), so an explicit null fails its validation and errors the whole poll (found on the first live connection test)", async () => {
    const res = await get("/api/public/traces?limit=100");
    const body = (await res.json()) as ListResponse;
    const sparse = body.data.find((t) => t.id === traceB.id) as unknown as Record<string, unknown>;
    expect(sparse).toBeDefined();
    for (const field of ["name", "userId", "sessionId", "environment", "release", "version", "input", "output"]) {
      expect(field in sparse, `field "${field}" must be absent, not null`).toBe(false);
    }
  });
});

describe("GET /api/public/traces/:id (LangFuse-shaped detail)", () => {
  it("returns the trace with observations and scores, LangFuse-cased", async () => {
    const res = await get(`/api/public/traces/${traceA.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      input: unknown;
      observations: Record<string, unknown>[];
      scores: Record<string, unknown>[];
    };

    expect(body.id).toBe(traceA.id);
    expect(body.input).toEqual({ question: "hi" });

    expect(body.observations).toHaveLength(1);
    const obs = body.observations[0]!;
    // LangFuse's wire uses UPPERCASE type/level — verified against a real
    // instance during M5; Ironside's own importer normalizes these back.
    expect(obs.type).toBe("GENERATION");
    expect(obs.level).toBe("ERROR");
    expect(obs.statusMessage).toBe("rate limited");
    expect(obs.model).toBe("gpt-4o");
    expect(obs.modelParameters).toEqual({ temperature: "0.7", max_tokens: "512" });
    expect(obs.usageDetails).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(obs.costDetails).toEqual({ total: 0.0012 });
    expect(obs.completionStartTime).toBe("2026-07-01T00:00:01.000Z");
    // Explicitly-recorded null output survives as null, not absent.
    expect("output" in obs).toBe(true);
    expect(obs.output).toBeNull();
    // ...while genuinely-unset optional fields are absent, not null (the
    // same omission contract as the trace list — coeval compatibility).
    expect("parentObservationId" in obs).toBe(false);

    expect(body.scores).toHaveLength(1);
    const score = body.scores[0]!;
    expect(score.name).toBe("quality");
    expect(score.dataType).toBe("NUMERIC");
    expect(score.source).toBe("EVAL");
    expect(score.value).toBe(0.5);
    expect(score.comment).toBe("solid");
  });

  it("404s for an unknown trace id", async () => {
    const res = await get(`/api/public/traces/trace_${ulid()}`);
    expect(res.status).toBe(404);
  });

  it("404s for another project's trace (scoping, not just obscurity)", async () => {
    const res = await get(`/api/public/traces/${traceA.id}`, otherApiKey);
    expect(res.status).toBe(404);
  });
});

async function postScore(payload: unknown, key = apiKey) {
  return app.request("/api/public/scores", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json", authorization: basicAuth(key) }
  });
}

/**
 * Finds the stored batch whose score-upsert event carries this score id.
 * Searches every job state (including "active" and "completed") with a
 * short retry, so the test is deterministic whether or not a worker
 * happens to be draining the shared queue concurrently (a dev worker
 * moves a job waiting → active → completed within milliseconds; completed
 * jobs are retained by the queue's removeOnComplete settings).
 */
async function scoreBatchById(scoreId: string): Promise<IngestBatch> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const jobs = await queue.getJobs(["waiting", "prioritized", "delayed", "active", "completed"]);
    for (const job of jobs) {
      if (job.data.projectId !== projectId) continue;
      const batch = (await storage.getJson(job.data.objectKey)) as IngestBatch;
      const event = batch.events[0];
      if (
        event?.type === "score-upsert" &&
        (event.body as { id?: string }).id === scoreId
      ) {
        return batch;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no queued batch found containing score ${scoreId}`);
}

describe("POST /api/public/scores (coeval verdict sync-back)", () => {
  it("accepts a coeval-shaped verdict score and enqueues a domain-valid score-upsert", async () => {
    const feedbackId = ulid();
    const res = await postScore({
      id: feedbackId,
      traceId: traceA.id,
      name: "coeval_verdict",
      value: 1,
      comment: "pass: the answer is grounded",
      metadata: {
        verdict: "pass",
        provider: "coeval",
        modelBinding: { model: "claude" }
      }
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: feedbackId });

    const batch = await scoreBatchById(feedbackId);
    const event = batch.events[0]!;
    expect(event.type).toBe("score-upsert");
    expect(event.source).toBe("native");

    // The body must satisfy the exact domain contract the worker's native
    // mapper re-validates — anything less is silently dropped there.
    const parsed = scoreSchema.parse({ ...(event.body as object), projectId });
    expect(parsed.id).toBe(feedbackId);
    expect(parsed.traceId).toBe(traceA.id);
    expect(parsed.name).toBe("coeval_verdict");
    expect(parsed.dataType).toBe("numeric");
    expect(parsed.value).toBe(1);
    expect(parsed.source).toBe("api");
    expect(parsed.comment).toBe("pass: the answer is grounded");
    // Non-string metadata values are stringified, not dropped.
    expect(parsed.metadata).toEqual({
      verdict: "pass",
      provider: "coeval",
      modelBinding: '{"model":"claude"}'
    });
  });

  it("maps a string value to a categorical stringValue", async () => {
    const res = await postScore({ traceId: traceA.id, name: "label", value: "thumbs_up" });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const batch = await scoreBatchById(id);
    const parsed = scoreSchema.parse({ ...(batch.events[0]!.body as object), projectId });
    expect(parsed.dataType).toBe("categorical");
    expect(parsed.stringValue).toBe("thumbs_up");
    expect(parsed.value).toBeUndefined();
  });

  it("honors a declared BOOLEAN dataType for a numeric value", async () => {
    const res = await postScore({ traceId: traceA.id, name: "correct", value: 0, dataType: "BOOLEAN" });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const batch = await scoreBatchById(id);
    const parsed = scoreSchema.parse({ ...(batch.events[0]!.body as object), projectId });
    expect(parsed.dataType).toBe("boolean");
    // value 0 must survive — falsy but meaningful.
    expect(parsed.value).toBe(0);
  });

  it("a declared BOOLEAN dataType with a STRING value falls back to categorical — boolean is only honored for numeric values (LangFuse booleans are numeric 0/1 on the wire)", async () => {
    const res = await postScore({ traceId: traceA.id, name: "flag", value: "true", dataType: "BOOLEAN" });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const batch = await scoreBatchById(id);
    const parsed = scoreSchema.parse({ ...(batch.events[0]!.body as object), projectId });
    expect(parsed.dataType).toBe("categorical");
    expect(parsed.stringValue).toBe("true");
    expect(parsed.value).toBeUndefined();
  });

  it("generates an id when the caller omits one", async () => {
    const res = await postScore({ traceId: traceA.id, name: "unnamed", value: 0.25 });
    const body = (await res.json()) as { id: string };
    expect(body.id).toBeTruthy();
  });

  it("rejects a score with no value with 400", async () => {
    const res = await postScore({ traceId: traceA.id, name: "no-value" });
    expect(res.status).toBe(400);
  });
});
