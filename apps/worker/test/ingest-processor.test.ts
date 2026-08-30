import {
  createClickHouseClient,
  getTraceRawIndex,
  hasPendingTraceRawRefs,
  insertRawEventRefs,
  insertTraces,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import {
  claimEvaluatorScoreReceipt,
  claimRawRetentionIntentExecution,
  createRawRetentionIntents,
  listProjectEnvironments,
  listIngestFailures,
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
