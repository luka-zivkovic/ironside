import {
  createClickHouseClient,
  getTrace,
  getTraceRawIndex,
  getVersionedTrace,
  hasPendingTraceRawRefs,
  insertObservations,
  insertRawEventRefs,
  insertScores,
  insertTraces,
  listObservationsForTrace,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import { mapNativeEvents } from "@ironside/mappers";
import {
  claimEvaluatorScoreReceipt,
  claimRawRetentionIntentExecution,
  createRawRetentionIntents,
  listProjectEnvironments,
  listIngestFailures,
  listTraceScoreActivities,
  markEvaluatorScoreReceiptStaged,
  publishEvaluatorTraceActivities,
  runMigrations as runPgMigrations
} from "@ironside/db";
import { createIngestQueue, enqueueBatch } from "@ironside/queue";
import type { IngestBatch } from "@ironside/shared";
import {
  INGEST_SCHEMA_VERSION,
  pendingIngestObjectKey,
  rawObjectKey
} from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  createIngestProcessor,
  recoverTerminalEvaluatorTraceRefs,
  settlePublishedEvaluatorTraceRefs
} from "../src/processors/ingest.js";

// End-to-end pipeline test: build the same envelope apps/api would produce,
// store it, enqueue it, then run the processor directly against the
// resulting job (avoids a real polling Worker + arbitrary wait in tests).

const config = loadConfig();
const pgConnectionString =
  process.env.DATABASE_URL ?? "postgres://ironside:ironside@localhost:5433/ironside";

const pool = new Pool({ connectionString: pgConnectionString });
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);
const processBatch = createIngestProcessor({ storage, clickhouse, pool });
const processBatchWithRetention = createIngestProcessor({
  storage,
  clickhouse,
  pool,
  retentionExecutionEnabled: true
});

let projectId: string;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();
  const orgId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "worker-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, "worker-test"]
  );
});

afterAll(async () => {
  await pool.query("delete from raw_retention_intents where project_id = $1", [projectId]);
  await pool.query("delete from organizations where name = 'worker-test-org'");
  await queue.close();
  await pool.end();
  await clickhouse.close();
  storage.close();
});

async function storeAndEnqueue(batch: IngestBatch) {
  const objectKey = rawObjectKey(batch.projectId, new Date(batch.receivedAt), batch.batchId);
  const pendingKey = pendingIngestObjectKey(batch.batchId);
  await storage.putJson(objectKey, batch);
  const message = {
    batchId: batch.batchId,
    projectId: batch.projectId,
    objectKey,
    eventCount: batch.events.length
  };
  await storage.putJson(pendingKey, message);
  await enqueueBatch(queue, message);
  const job = await queue.getJob(batch.batchId);
  if (!job) throw new Error("job not found after enqueue");
  return job;
}

describe("ingest processor", () => {
  it("does not resurrect a batch after its retention intent becomes irreversible", async () => {
    const traceId = `trace_${ulid()}`;
    const batch: IngestBatch = {
      batchId: ulid(),
      projectId,
      receivedAt: new Date().toISOString(),
      events: [
        {
          id: ulid(),
          type: "trace-upsert",
          source: "native",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: "retention-no-resurrection",
          body: { id: traceId, timestamp: new Date().toISOString() }
        }
      ]
    };
    const job = await storeAndEnqueue(batch);
    const metadata = await storage.stat(job.data.objectKey);
    if (!metadata) throw new Error("expected stored raw object");
    const intentId = `rti_${ulid()}`;
    await createRawRetentionIntents(pool, [
      {
        id: intentId,
        preparationId: `rtp_${ulid()}`,
        projectId,
        ingestBatchId: batch.batchId,
        objectKey: job.data.objectKey,
        objectSizeBytes: metadata.sizeBytes,
        retentionCutoffDay: "2026-01-01",
        effectiveRetentionDays: 90,
        traceIds: [traceId],
        classification: "applied",
        diagnosticCount: 0
      }
    ]);
    await claimRawRetentionIntentExecution(pool, projectId, intentId);

    await processBatchWithRetention(job);

    expect(await storage.exists(pendingIngestObjectKey(batch.batchId))).toBe(false);
    expect(await storage.exists(job.data.objectKey)).toBe(true);
    const result = await clickhouse.query({
      query: "select count() as count from traces final where project_id = {projectId:String} and id = {id:String}",
      query_params: { projectId, id: traceId },
      format: "JSONEachRow"
    });
    expect(await result.json()).toEqual([{ count: "0" }]);
    await job.remove();
    await storage.delete(job.data.objectKey);
  });

  it("maps a queued native trace batch into ClickHouse", async () => {
    const traceId = `trace_${ulid()}`;
    const batchId = ulid();
    const batch: IngestBatch = {
      batchId,
      projectId,
      receivedAt: new Date().toISOString(),
      events: [
        {
          id: ulid(),
          type: "trace-upsert",
          source: "native",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: "hash-1",
          body: {
            id: traceId,
            // Keep this integration fixture inside every concurrent retention
            // window. A fixed historical timestamp eventually becomes a
            // legitimate deletion target for another test file.
            timestamp: new Date().toISOString(),
            name: "checkout",
            environment: "production",
            metadata: { plan: "pro" }
          }
        }
      ]
    };

    const job = await storeAndEnqueue(batch);
    await processBatch(job);

    expect(await storage.exists(pendingIngestObjectKey(batchId))).toBe(false);
    const rawIndex = await getTraceRawIndex(clickhouse, projectId, traceId, 500);
    await job.remove();

    const result = await clickhouse.query({
      query: "select * from traces final where id = {id:String}",
      query_params: { id: traceId },
      format: "JSONEachRow"
    });
    const rows = await result.json<{ name: string; metadata: Record<string, string> }>();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("checkout");
    expect(rows[0]?.metadata).toEqual({ plan: "pro" });
    expect(
      (await listProjectEnvironments(pool, projectId)).environments.some(
        (environment) => environment.name === "production"
      )
    ).toBe(true);
    expect(rawIndex).toEqual({
      objectKeys: [job.data.objectKey],
      hasPendingRefs: false,
      retentionExpired: false
    });
  });

  it("skips a malformed event but still inserts the valid ones in the same batch", async () => {
    const goodTraceId = `trace_${ulid()}`;
    const batch: IngestBatch = {
      batchId: ulid(),
      projectId,
      receivedAt: new Date().toISOString(),
      events: [
        {
          id: ulid(),
          type: "trace-upsert",
          source: "native",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: "hash-bad",
          body: { not: "a valid trace" }
        },
        {
          id: ulid(),
          type: "trace-upsert",
          source: "native",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: "hash-good",
          body: {
            id: goodTraceId,
            timestamp: "2026-07-12T00:00:00.000Z",
            name: "good-trace"
          }
        }
      ]
    };

    const job = await storeAndEnqueue(batch);
    await expect(processBatch(job)).resolves.not.toThrow();
    await job.remove();

    const result = await clickhouse.query({
      query: "select id from traces final where id = {id:String}",
      query_params: { id: goodTraceId },
      format: "JSONEachRow"
    });
    expect(await result.json()).toHaveLength(1);
  });

  it("re-processing the same batch upserts rather than duplicating (ReplacingMergeTree)", async () => {
    const traceId = `trace_${ulid()}`;
    const batch: IngestBatch = {
      batchId: ulid(),
      projectId,
      receivedAt: new Date().toISOString(),
      events: [
        {
          id: ulid(),
          type: "trace-upsert",
          source: "native",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: "hash-dup",
          body: {
            id: traceId,
            timestamp: "2026-07-12T00:00:00.000Z",
            name: "dup-trace"
          }
        }
      ]
    };

    const job = await storeAndEnqueue(batch);
    await processBatch(job);
    await processBatch(job);
    await job.remove();

    const result = await clickhouse.query({
      query: "select id from traces final where id = {id:String}",
      query_params: { id: traceId },
      format: "JSONEachRow"
    });
    expect(await result.json()).toHaveLength(1);
  });

  it("keeps score-only batches from blocking evaluator snapshots", async () => {
    const traceId = `trace_${ulid()}`;
    const batch: IngestBatch = {
      batchId: ulid(),
      projectId,
      receivedAt: new Date().toISOString(),
      events: [
        {
          id: ulid(),
          type: "score-upsert",
          source: "native",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: "score-only-ref",
          body: {
            id: `score_${ulid()}`,
            traceId,
            name: "quality",
            dataType: "numeric",
            value: 0.9,
            source: "eval"
          }
        }
      ]
    };
    const job = await storeAndEnqueue(batch);
    await processBatch(job);

    await expect(hasPendingTraceRawRefs(clickhouse, projectId, traceId)).resolves.toBe(false);
    await job.remove();
  });

  it("keeps a staged evaluator score retryable until ClickHouse materializes it", async () => {
    const traceId = `trace_${ulid()}`;
    const scoreId = `score_${ulid()}`;
    const batchId = ulid();
    const batch: IngestBatch = {
      batchId,
      projectId,
      receivedAt: new Date().toISOString(),
      events: [{
        id: `event_${batchId}`,
        type: "score-upsert",
        source: "native",
        schemaVersion: INGEST_SCHEMA_VERSION,
        idempotencyKey: "evaluator-score-terminal-recovery",
        body: {
          id: scoreId,
          traceId,
          name: "quality",
          dataType: "numeric",
          value: 0.9,
          source: "eval"
        }
      }]
    };
    await claimEvaluatorScoreReceipt(pool, {
      projectId,
      scoreId,
      traceId,
      requestFingerprint: "c".repeat(64),
      candidateBatchId: batchId
    });
    await markEvaluatorScoreReceiptStaged(pool, { projectId, scoreId, batchId });
    const job = await storeAndEnqueue(batch);

    await expect(recoverTerminalEvaluatorTraceRefs(
      { storage, clickhouse, pool },
      job.data
    )).resolves.toBe("retry");
    await processBatch(job);
    await expect(recoverTerminalEvaluatorTraceRefs(
      { storage, clickhouse, pool },
      job.data
    )).resolves.toBe("quarantine");
    await job.remove();
  });

  it("settles a raw ref when a job fails after its evaluator publication commits", async () => {
    const traceId = `trace_${ulid()}`;
    const batch: IngestBatch = {
      batchId: ulid(),
      projectId,
      receivedAt: new Date().toISOString(),
      events: [
        {
          id: ulid(),
          type: "trace-upsert",
          source: "native",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: "post-publication-recovery",
          body: { id: traceId, timestamp: "2026-07-12T00:00:00.000Z" }
        }
      ]
    };
    const job = await storeAndEnqueue(batch);
    const ref = {
      projectId,
      traceId,
      objectKey: job.data.objectKey,
      receivedAt: batch.receivedAt
    };
    await insertRawEventRefs(clickhouse, [ref], batch.receivedAt, false);
    await expect(recoverTerminalEvaluatorTraceRefs(
      { storage, clickhouse, pool },
      job.data
    )).resolves.toBe("retry");
    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [traceId],
      sourceActivityAt: batch.receivedAt,
      activityId: batch.batchId
    });
    await expect(hasPendingTraceRawRefs(clickhouse, projectId, traceId)).resolves.toBe(true);

    await expect(settlePublishedEvaluatorTraceRefs(
      { storage, clickhouse, pool },
      job.data
    )).resolves.toBe(1);
    await expect(hasPendingTraceRawRefs(clickhouse, projectId, traceId)).resolves.toBe(false);
    await expect(recoverTerminalEvaluatorTraceRefs(
      { storage, clickhouse, pool },
      job.data
    )).resolves.toBe("quarantine");
    await job.remove();
  });
});

describe("ingest processor dead-lettering (M9-03)", () => {
  it("persists a failure row per unmappable event, inserts the valid events anyway, and fires the metrics hook — across native, OTLP, and LangFuse sources", async () => {
    const goodTraceId = `trace_${ulid()}`;
    const badNativeEventId = ulid();
    const badOtlpEventId = ulid();
    const badLangfuseEventId = ulid();
    const batchId = ulid();
    const batch: IngestBatch = {
      batchId,
      projectId,
      receivedAt: new Date().toISOString(),
      events: [
        {
          id: ulid(),
          type: "trace-upsert",
          source: "native",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: "dl-good",
          body: { id: goodTraceId, timestamp: "2026-07-12T00:00:00.000Z", name: "survives" }
        },
        {
          id: badNativeEventId,
          type: "trace-upsert",
          source: "native",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: "dl-bad-native",
          body: { name: "no id or timestamp — fails the domain schema" }
        },
        {
          id: badOtlpEventId,
          type: "otlp-export",
          source: "otlp",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: "dl-bad-otlp",
          body: { resourceSpans: "not-an-array" }
        },
        {
          id: badLangfuseEventId,
          type: "langfuse-ingestion",
          source: "langfuse",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: "dl-bad-langfuse",
          body: { notABatch: true }
        }
      ]
    };

    let deadLetteredCount = 0;
    const processWithDeadLetters = createIngestProcessor({
      storage,
      clickhouse,
      pool,
      onDeadLetter: (count) => {
        deadLetteredCount += count;
      }
    });

    const job = await storeAndEnqueue(batch);
    await processWithDeadLetters(job);
    await job.remove();

    // The valid trace still landed.
    const result = await clickhouse.query({
      query: "select id from traces final where id = {id:String}",
      query_params: { id: goodTraceId },
      format: "JSONEachRow"
    });
    expect(await result.json()).toHaveLength(1);

    // Every unmappable event became a queryable failure row.
    const failures = await listIngestFailures(pool, projectId, 100);
    const forThisBatch = failures.filter((f) => f.batchId === batchId);
    expect(forThisBatch).toHaveLength(3);
    expect(deadLetteredCount).toBe(3);

    const sources = forThisBatch.map((f) => f.source).sort();
    expect(sources).toEqual(["langfuse", "native", "otlp"]);

    const nativeFailure = forThisBatch.find((f) => f.source === "native");
    expect(nativeFailure?.eventId).toBe(badNativeEventId);
    expect(nativeFailure?.eventType).toBe("trace-upsert");
    expect(nativeFailure?.error).toBeTruthy();
    // The pointer back to the raw payload: the exact object key the batch
    // was stored under, so the failed body is recoverable for debugging.
    expect(nativeFailure?.objectKey).toContain(batchId);
  });

  it("dead-letters a per-event LangFuse MAPPING failure (valid envelope, unmappable inner event), keyed by the INNER SDK event id — the path distinct from an invalid envelope", async () => {
    const innerEventId = `lf_evt_${ulid()}`;
    const batchId = ulid();
    const batch: IngestBatch = {
      batchId,
      projectId,
      receivedAt: new Date().toISOString(),
      events: [
        {
          id: ulid(),
          type: "langfuse-ingestion",
          source: "langfuse",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: "dl-inner-langfuse",
          body: {
            batch: [
              {
                id: innerEventId,
                timestamp: new Date().toISOString(),
                type: "score-create",
                // A score with neither value nor stringValue fails the
                // domain invariant inside the mapper — a MAPPING error on
                // an envelope that parsed fine.
                body: { id: `score_${ulid()}`, traceId: "trace_x", name: "broken" }
              }
            ]
          }
        }
      ]
    };

    const processWithDeadLetters = createIngestProcessor({ storage, clickhouse, pool });
    const job = await storeAndEnqueue(batch);
    await processWithDeadLetters(job);
    await job.remove();

    const failures = await listIngestFailures(pool, projectId, 100);
    const failure = failures.find((f) => f.batchId === batchId);
    expect(failure).toBeDefined();
    // Keyed by the INNER LangFuse event id (what a 207 response keys on),
    // not the outer envelope event's id.
    expect(failure?.eventId).toBe(innerEventId);
    expect(failure?.source).toBe("langfuse");
    expect(failure?.error).toBeTruthy();
  });

  it("a dead-letter WRITE failure never fails the batch — the trace data already inserted", async () => {
    const traceId = `trace_${ulid()}`;
    const batch: IngestBatch = {
      batchId: ulid(),
      projectId,
      receivedAt: new Date().toISOString(),
      events: [
        {
          id: ulid(),
          type: "trace-upsert",
          source: "native",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: "dl-write-fail-good",
          body: { id: traceId, timestamp: "2026-07-12T00:00:00.000Z" }
        },
        {
          id: ulid(),
          type: "trace-upsert",
          source: "native",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: "dl-write-fail-bad",
          body: { broken: true }
        }
      ]
    };

    // Preserve the retention coordination reads/locks while failing exactly
    // the best-effort diagnostic insert.
    const brokenPool = {
      connect: pool.connect.bind(pool),
      options: pool.options,
      query: (text: string, params?: unknown[]) =>
        text.includes("insert into ingest_event_failures")
          ? Promise.reject(new Error("postgres unavailable"))
          : pool.query(text, params)
    } as unknown as Pool;

    const processWithBrokenPool = createIngestProcessor({
      storage,
      clickhouse,
      pool: brokenPool
    });
    const job = await storeAndEnqueue(batch);
    await expect(processWithBrokenPool(job)).resolves.not.toThrow();
    await job.remove();

    const result = await clickhouse.query({
      query: "select id from traces final where id = {id:String}",
      query_params: { id: traceId },
      format: "JSONEachRow"
    });
    expect(await result.json()).toHaveLength(1);
  });
});

describe("LangFuse create and update in separate requests", () => {
  function langfuseBatch(receivedAt: string, events: unknown[]): IngestBatch {
    return {
      batchId: ulid(),
      projectId,
      receivedAt,
      events: [
        {
          id: ulid(),
          type: "langfuse-ingestion",
          source: "langfuse",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: ulid(),
          body: { batch: events }
        }
      ]
    };
  }

  async function processLangfuseBatch(batch: IngestBatch): Promise<void> {
    const job = await storeAndEnqueue(batch);
    await processBatch(job);
    await job.remove();
  }

  it("keeps the fields only the create sent when the update arrives in a later request", async () => {
    const traceId = `trace_${ulid()}`;
    const generationId = `gen_${ulid()}`;
    const startedAt = new Date(Date.now() - 10_000);
    const endedAt = new Date(startedAt.getTime() + 3_000);

    // What the LangFuse SDK flushes while the model call is still running.
    await processLangfuseBatch(
      langfuseBatch(startedAt.toISOString(), [
        {
          id: ulid(),
          timestamp: startedAt.toISOString(),
          type: "trace-create",
          body: {
            id: traceId,
            timestamp: startedAt.toISOString(),
            name: "checkout",
            userId: "user_1",
            tags: ["prod"],
            input: { question: "hi" }
          }
        },
        {
          id: ulid(),
          timestamp: startedAt.toISOString(),
          type: "generation-create",
          body: {
            id: generationId,
            traceId,
            name: "llm-call",
            model: "gpt-4o",
            startTime: startedAt.toISOString(),
            input: [{ role: "user", content: "hi" }]
          }
        }
      ])
    );

    // The next flush, after the call finished. The SDK sends explicit nulls
    // for fields an update is not setting.
    await processLangfuseBatch(
      langfuseBatch(endedAt.toISOString(), [
        {
          id: ulid(),
          timestamp: endedAt.toISOString(),
          type: "generation-update",
          body: {
            id: generationId,
            traceId,
            name: null,
            input: null,
            endTime: endedAt.toISOString(),
            output: { text: "hello" },
            usage: { promptTokens: 5, completionTokens: 2 }
          }
        },
        {
          id: ulid(),
          timestamp: endedAt.toISOString(),
          type: "trace-create",
          body: { id: traceId, output: { answer: "hello" } }
        }
      ])
    );

    const trace = await getTrace(clickhouse, projectId, traceId);
    expect(trace).toMatchObject({
      name: "checkout",
      user_id: "user_1",
      tags: ["prod"],
      timestamp: startedAt.toISOString()
    });
    expect(JSON.parse(trace?.input ?? "null")).toEqual({ question: "hi" });
    expect(JSON.parse(trace?.output ?? "null")).toEqual({ answer: "hello" });

    const observations = await listObservationsForTrace(clickhouse, projectId, traceId);
    expect(observations).toHaveLength(1);
    const generation = observations[0];
    expect(generation).toMatchObject({
      id: generationId,
      name: "llm-call",
      model: "gpt-4o",
      start_time: startedAt.toISOString(),
      end_time: endedAt.toISOString(),
      usage_details: { input_tokens: 5, output_tokens: 2 }
    });
    expect(JSON.parse(generation?.input ?? "null")).toEqual([{ role: "user", content: "hi" }]);
    expect(JSON.parse(generation?.output ?? "null")).toEqual({ text: "hello" });
    // Model from the create plus usage from the update is enough to derive cost.
    expect(generation?.cost_details.total).toBeCloseTo(0.0000325, 9);
  });
});

describe("LangFuse create and update processed out of order or concurrently", () => {
  function langfuseBatch(receivedAt: string, events: unknown[]): IngestBatch {
    return {
      batchId: ulid(),
      projectId,
      receivedAt,
      events: [
        {
          id: ulid(),
          type: "langfuse-ingestion",
          source: "langfuse",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: ulid(),
          body: { batch: events }
        }
      ]
    };
  }

  /** The two requests the LangFuse SDK sends for one model call that spans a flush. */
  function requestsForOneCall(startedAt: Date, endedAt: Date) {
    const traceId = `trace_${ulid()}`;
    const generationId = `gen_${ulid()}`;
    const create = langfuseBatch(startedAt.toISOString(), [
      {
        id: ulid(),
        timestamp: startedAt.toISOString(),
        type: "trace-create",
        body: { id: traceId, timestamp: startedAt.toISOString(), name: "checkout", userId: "user_1", input: { q: "hi" } }
      },
      {
        id: ulid(),
        timestamp: startedAt.toISOString(),
        type: "generation-create",
        body: {
          id: generationId,
          traceId,
          name: "llm-call",
          model: "gpt-4o",
          startTime: startedAt.toISOString(),
          input: [{ role: "user", content: "hi" }]
        }
      }
    ]);
    const update = langfuseBatch(endedAt.toISOString(), [
      {
        id: ulid(),
        timestamp: endedAt.toISOString(),
        type: "generation-update",
        body: {
          id: generationId,
          traceId,
          name: null,
          input: null,
          endTime: endedAt.toISOString(),
          output: { text: "hello" },
          usage: { promptTokens: 5, completionTokens: 2 }
        }
      },
      {
        id: ulid(),
        timestamp: endedAt.toISOString(),
        type: "trace-create",
        body: { id: traceId, output: { a: "hello" } }
      }
    ]);
    return { traceId, generationId, create, update };
  }

  async function expectComplete(
    call: ReturnType<typeof requestsForOneCall>,
    startedAt: Date,
    endedAt: Date
  ): Promise<void> {
    const trace = await getTrace(clickhouse, projectId, call.traceId);
    expect(trace).toMatchObject({ name: "checkout", user_id: "user_1", timestamp: startedAt.toISOString() });
    expect(JSON.parse(trace?.input ?? "null")).toEqual({ q: "hi" });
    expect(JSON.parse(trace?.output ?? "null")).toEqual({ a: "hello" });
    const observations = await listObservationsForTrace(clickhouse, projectId, call.traceId);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      name: "llm-call",
      model: "gpt-4o",
      start_time: startedAt.toISOString(),
      end_time: endedAt.toISOString(),
      usage_details: { input_tokens: 5, output_tokens: 2 }
    });
    expect(JSON.parse(observations[0]?.input ?? "null")).toEqual([{ role: "user", content: "hi" }]);
    expect(JSON.parse(observations[0]?.output ?? "null")).toEqual({ text: "hello" });
    expect(observations[0]?.cost_details.total).toBeCloseTo(0.0000325, 9);
  }

  async function run(batch: IngestBatch): Promise<void> {
    const job = await storeAndEnqueue(batch);
    await processBatch(job);
    await job.remove();
  }

  it("builds the complete record when the update's request is processed before the create's", async () => {
    const startedAt = new Date(Date.now() - 10_000);
    const endedAt = new Date(startedAt.getTime() + 3_000);
    const call = requestsForOneCall(startedAt, endedAt);

    await run(call.update);
    await run(call.create);

    await expectComplete(call, startedAt, endedAt);
    // The late create did not move the trace's latest activity.
    expect((await getVersionedTrace(clickhouse, projectId, call.traceId))?.trace_version).toBe(
      endedAt.toISOString()
    );
  });

  it("leaves one row per record when the late create moves its start to the previous day", async () => {
    // The update's placeholder start time falls after midnight UTC, the real one before.
    const midnight = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
    const startedAt = new Date(midnight.getTime() - 2_000);
    const endedAt = new Date(midnight.getTime() + 2_000);
    const call = requestsForOneCall(startedAt, endedAt);

    await run(call.update);
    await run(call.create);

    await expectComplete(call, startedAt, endedAt);
    const rows = await clickhouse.query({
      query: `select
                (select count() from traces final where project_id = {projectId:String} and id = {traceId:String}) as traces,
                (select count() from observations final where project_id = {projectId:String} and id = {generationId:String}) as observations`,
      query_params: { projectId, traceId: call.traceId, generationId: call.generationId },
      format: "JSONEachRow"
    });
    expect(await rows.json()).toEqual([{ traces: "1", observations: "1" }]);
  });

  it("builds the complete record when the update's batch is retried after failing before its field times were recorded", async () => {
    const startedAt = new Date(Date.now() - 10_000);
    const endedAt = new Date(startedAt.getTime() + 3_000);
    const call = requestsForOneCall(startedAt, endedAt);

    await run(call.update);
    // The rows are written, the field times are not: as if the job failed in between.
    await pool.query("delete from langfuse_field_provenance where project_id = $1 and entity_id = any($2)", [
      projectId,
      [call.traceId, call.generationId]
    ]);
    await run(call.update);
    await run(call.create);

    await expectComplete(call, startedAt, endedAt);
  });

  it("builds the complete record when both requests are processed at the same time", async () => {
    const calls = Array.from({ length: 8 }, (_, index) => {
      const startedAt = new Date(Date.now() - 20_000 - index * 1_000);
      const endedAt = new Date(startedAt.getTime() + 3_000);
      return { startedAt, endedAt, ...requestsForOneCall(startedAt, endedAt) };
    });
    const jobs = await Promise.all(
      calls.flatMap((call) => [storeAndEnqueue(call.create), storeAndEnqueue(call.update)])
    );

    await Promise.all(jobs.map((job) => processBatch(job)));
    await Promise.all(jobs.map((job) => job.remove()));

    for (const call of calls) await expectComplete(call, call.startedAt, call.endedAt);
  });
});

describe("score feed publication", () => {
  it("moves the score feed only for traces a batch touched with scores alone", async () => {
    const scoredOnly = `trace_${ulid()}`;
    const withActivity = `trace_${ulid()}`;
    const now = new Date().toISOString();
    const score = (traceId: string): IngestBatch["events"][number] => ({
      id: ulid(),
      type: "score-upsert",
      source: "native",
      schemaVersion: INGEST_SCHEMA_VERSION,
      idempotencyKey: ulid(),
      body: { id: `score_${ulid()}`, traceId, name: "helpful", dataType: "numeric", value: 1, source: "api", metadata: {} }
    });
    const batch: IngestBatch = {
      batchId: ulid(),
      projectId,
      receivedAt: now,
      events: [
        {
          id: ulid(),
          type: "trace-upsert",
          source: "native",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: ulid(),
          body: { id: withActivity, timestamp: now }
        },
        score(withActivity),
        score(scoredOnly)
      ]
    };
    const job = await storeAndEnqueue(batch);
    await processBatch(job);
    await job.remove();

    const published = (await listTraceScoreActivities(pool, { projectId, limit: 1_000 })).map(
      (entry) => entry.traceId
    );
    expect(published).toContain(scoredOnly);
    expect(published).not.toContain(withActivity);
  });
});

describe("a record written again with a timestamp on another day", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const dayStart = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  /** Noon on the day `days` before today, UTC. */
  const noon = (days: number) => new Date(dayStart - days * DAY + 12 * 60 * 60 * 1000).toISOString();

  function nativeBatch(receivedAt: string, events: { type: IngestBatch["events"][number]["type"]; body: unknown }[]): IngestBatch {
    return {
      batchId: ulid(),
      projectId,
      receivedAt,
      events: events.map((event) => ({
        id: ulid(),
        type: event.type,
        source: "native" as const,
        schemaVersion: INGEST_SCHEMA_VERSION,
        idempotencyKey: ulid(),
        body: event.body
      }))
    };
  }

  async function run(batch: IngestBatch): Promise<void> {
    const job = await storeAndEnqueue(batch);
    await processBatch(job);
    await job.remove();
  }

  /** Writes observations and scores directly, as a race between batches could have left them. */
  async function observationsAndScores(
    events: { type: "observation-upsert" | "score-upsert"; body: Record<string, unknown> }[],
    eventTs: string
  ): Promise<void> {
    const { rows } = mapNativeEvents(projectId, nativeBatch(eventTs, events).events);
    await insertObservations(clickhouse, rows.observations, { eventTs });
    await insertScores(clickhouse, rows.scores, { eventTs });
  }

  async function liveRows(table: "traces" | "observations" | "scores", id: string, column: string): Promise<string[]> {
    const result = await clickhouse.query({
      query: `select toString(${column}) as at from ${table} final where project_id = {projectId:String} and id = {id:String}`,
      query_params: { projectId, id },
      format: "JSONEachRow"
    });
    return (await result.json<{ at: string }>()).map((row) => row.at.slice(0, 10));
  }

  it("keeps one trace and one observation, under the newer batch's day", async () => {
    const traceId = `trace_${ulid()}`;
    const observationId = `obs_${ulid()}`;
    for (const day of [2, 1]) {
      await run(
        nativeBatch(noon(day), [
          { type: "trace-upsert", body: { id: traceId, timestamp: noon(day), name: "checkout" } },
          { type: "observation-upsert", body: { id: observationId, traceId, type: "span", startTime: noon(day) } }
        ])
      );
    }
    expect(await liveRows("traces", traceId, "timestamp")).toEqual([noon(1).slice(0, 10)]);
    expect(await liveRows("observations", observationId, "start_time")).toEqual([noon(1).slice(0, 10)]);
  });

  it("leaves out a stale batch's row when the record is stored newer under another day", async () => {
    const traceId = `trace_${ulid()}`;
    // Received second, processed first.
    await run(nativeBatch(noon(1), [{ type: "trace-upsert", body: { id: traceId, timestamp: noon(1), name: "newer" } }]));
    await run(nativeBatch(noon(2), [{ type: "trace-upsert", body: { id: traceId, timestamp: noon(2), name: "older" } }]));

    expect(await liveRows("traces", traceId, "timestamp")).toEqual([noon(1).slice(0, 10)]);
    expect((await getTrace(clickhouse, projectId, traceId))?.name).toBe("newer");
  });

  it("keeps one score when it is sent again without a timestamp on a later day, and a retry lands on the same key", async () => {
    const traceId = `trace_${ulid()}`;
    const scoreId = `score_${ulid()}`;
    const score = { id: scoreId, traceId, name: "helpful", dataType: "numeric", value: 1, source: "api", metadata: {} };
    const first = nativeBatch(noon(2), [{ type: "score-upsert", body: score }]);
    await run(first);
    await run(first);
    expect(await liveRows("scores", scoreId, "timestamp")).toEqual([noon(2).slice(0, 10)]);

    await run(nativeBatch(noon(1), [{ type: "score-upsert", body: { ...score, value: 0 } }]));
    expect(await liveRows("scores", scoreId, "timestamp")).toEqual([noon(1).slice(0, 10)]);
  });

  it("keeps a record's last row when one batch writes it on two days, also when the batch is retried", async () => {
    const traceId = `trace_${ulid()}`;
    const scoreId = `score_${ulid()}`;
    const score = { id: scoreId, traceId, name: "helpful", dataType: "numeric", source: "api", metadata: {} };
    const batch = nativeBatch(noon(1), [
      { type: "trace-upsert", body: { id: traceId, timestamp: noon(2), name: "first" } },
      { type: "trace-upsert", body: { id: traceId, timestamp: noon(1), name: "last" } },
      { type: "score-upsert", body: { ...score, value: 0, timestamp: noon(2) } },
      { type: "score-upsert", body: { ...score, value: 1, timestamp: noon(1) } }
    ]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await run(batch);
      expect(await liveRows("traces", traceId, "timestamp")).toEqual([noon(1).slice(0, 10)]);
      expect((await getTrace(clickhouse, projectId, traceId))?.name).toBe("last");
      expect(await liveRows("scores", scoreId, "timestamp")).toEqual([noon(1).slice(0, 10)]);
    }
  });

  it("keeps the batch's last row when it moves a stored record away and back", async () => {
    const traceId = `trace_${ulid()}`;
    await run(nativeBatch(noon(3), [{ type: "trace-upsert", body: { id: traceId, timestamp: noon(3), name: "stored" } }]));
    await run(
      nativeBatch(noon(1), [
        { type: "trace-upsert", body: { id: traceId, timestamp: noon(2), name: "moved" } },
        { type: "trace-upsert", body: { id: traceId, timestamp: noon(3), name: "moved back" } }
      ])
    );
    expect(await liveRows("traces", traceId, "timestamp")).toEqual([noon(3).slice(0, 10)]);
    expect((await getTrace(clickhouse, projectId, traceId))?.name).toBe("moved back");
  });

  it("leaves out stale observations and scores too, and still removes stored rows older than the batch", async () => {
    const traceId = `trace_${ulid()}`;
    const observationId = `obs_${ulid()}`;
    const scoreId = `score_${ulid()}`;
    const events = (day: number, name: string) => [
      { type: "observation-upsert" as const, body: { id: observationId, traceId, type: "span", name, startTime: noon(day) } },
      { type: "score-upsert" as const, body: { id: scoreId, traceId, name, dataType: "numeric", value: 1, source: "api", metadata: {}, timestamp: noon(day) } }
    ];
    // An older duplicate on day 3 and the newest row on day 1, as a race could leave them.
    await observationsAndScores(events(3, "old"), noon(3));
    await observationsAndScores(events(1, "newest"), noon(1));
    // Received on day 2 with rows on day 3: stale, but newer than the old duplicate.
    await run(nativeBatch(noon(2), events(3, "stale")));

    expect(await liveRows("observations", observationId, "start_time")).toEqual([noon(1).slice(0, 10)]);
    expect(await liveRows("scores", scoreId, "timestamp")).toEqual([noon(1).slice(0, 10)]);
  });

  it("lets the later-processed batch win when two batches with the same receive time write different days", async () => {
    const traceId = `trace_${ulid()}`;
    await run(nativeBatch(noon(1), [{ type: "trace-upsert", body: { id: traceId, timestamp: noon(2), name: "first" } }]));
    await run(nativeBatch(noon(1), [{ type: "trace-upsert", body: { id: traceId, timestamp: noon(1), name: "second" } }]));
    expect(await liveRows("traces", traceId, "timestamp")).toEqual([noon(1).slice(0, 10)]);
    expect((await getTrace(clickhouse, projectId, traceId))?.name).toBe("second");
  });

  it("applies to OTLP spans and LangFuse-compatible scores", async () => {
    const traceHex = ulid().toLowerCase().padEnd(32, "0").slice(0, 32).replace(/[^0-9a-f]/g, "a");
    const spanHex = traceHex.slice(0, 16);
    const nanos = (iso: string) => `${BigInt(Date.parse(iso)) * 1_000_000n}`;
    const otlp = (day: number): IngestBatch => ({
      ...nativeBatch(noon(day), []),
      events: [
        {
          id: ulid(),
          type: "otlp-export",
          source: "otlp",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: ulid(),
          body: {
            resourceSpans: [
              {
                resource: { attributes: [] },
                scopeSpans: [
                  {
                    spans: [
                      { traceId: traceHex, spanId: spanHex, name: "root", startTimeUnixNano: nanos(noon(day)), endTimeUnixNano: nanos(noon(day)) }
                    ]
                  }
                ]
              }
            ]
          }
        }
      ]
    });
    await run(otlp(2));
    await run(otlp(1));
    expect(await liveRows("traces", traceHex, "timestamp")).toEqual([noon(1).slice(0, 10)]);
    expect(await liveRows("observations", spanHex, "start_time")).toEqual([noon(1).slice(0, 10)]);

    const scoreId = `score_${ulid()}`;
    const langfuseScore = (day: number): IngestBatch => ({
      ...nativeBatch(noon(day), []),
      events: [
        {
          id: ulid(),
          type: "langfuse-ingestion",
          source: "langfuse",
          schemaVersion: INGEST_SCHEMA_VERSION,
          idempotencyKey: ulid(),
          body: {
            batch: [
              { id: ulid(), timestamp: noon(day), type: "score-create", body: { id: scoreId, traceId: traceHex, name: "verdict", value: 1 } }
            ]
          }
        }
      ]
    });
    await run(langfuseScore(2));
    await run(langfuseScore(1));
    expect(await liveRows("scores", scoreId, "timestamp")).toEqual([noon(1).slice(0, 10)]);
  });

  it("removes duplicates written before this fix when the record is written again", async () => {
    const traceId = `trace_${ulid()}`;
    const trace = (day: number) => ({ id: traceId, projectId, timestamp: noon(day), tags: [], metadata: {} });
    await insertTraces(clickhouse, [trace(3)], { eventTs: noon(3) });
    await insertTraces(clickhouse, [trace(2)], { eventTs: noon(2) });
    expect(await liveRows("traces", traceId, "timestamp")).toHaveLength(2);

    await run(nativeBatch(noon(1), [{ type: "trace-upsert", body: { id: traceId, timestamp: noon(1) } }]));
    expect(await liveRows("traces", traceId, "timestamp")).toEqual([noon(1).slice(0, 10)]);
  });
});
