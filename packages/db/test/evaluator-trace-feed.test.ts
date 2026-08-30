import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimEvaluatorScoreReceipt,
  claimPendingEvaluatorImportSnapshots,
  deleteEvaluatorTraceFeedEntries,
  EvaluatorScoreIdempotencyConflictError,
  listPendingEvaluatorImportTraceIds,
  listEvaluatorTraceFeedKeys,
  listEvaluatorTraceActivities,
  markEvaluatorScoreReceiptMaterialized,
  markEvaluatorScoreReceiptStaged,
  publishEvaluatorTraceActivities,
  stageEvaluatorImportTraces
} from "../src/evaluator-trace-feed.js";
import { claimImportRun } from "../src/import-checkpoints.js";
import { runMigrations } from "../src/migrate.js";

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://ironside:ironside@localhost:5433/ironside";

describe("evaluator trace feed (postgres)", () => {
  const pool = new Pool({ connectionString });
  const organizationId = `org_eval_feed_${ulid()}`;
  const projectId = `proj_eval_feed_${ulid()}`;

  beforeAll(async () => {
    await runMigrations(pool);
    await pool.query("insert into organizations (id, name) values ($1, $2)", [
      organizationId,
      "evaluator trace feed"
    ]);
    await pool.query(
      "insert into projects (id, organization_id, name) values ($1, $2, $3)",
      [projectId, organizationId, "evaluator trace feed"]
    );
  });

  afterAll(async () => {
    await pool.query("delete from organizations where id = $1", [organizationId]);
    await pool.end();
  });

  it("preserves microsecond cursors, deduplicates retries, and republishes late older activity", async () => {
    const traceId = `trace_${ulid()}`;
    const newerSourceActivity = "2026-08-20T12:00:00.000Z";
    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [traceId],
      sourceActivityAt: newerSourceActivity,
      activityId: "batch-newer"
    });

    await pool.query(
      `update evaluator_trace_feed
          set trace_version = '2026-08-30T12:00:00.123456Z'::timestamptz,
              published_at = '2026-08-30T12:00:00.123456Z'::timestamptz
        where project_id = $1 and trace_id = $2`,
      [projectId, traceId]
    );
    await pool.query(
      `update evaluator_trace_feed_watermarks
          set published_at = '2026-08-30T12:00:00.123456Z'::timestamptz
        where project_id = $1`,
      [projectId]
    );
    const first = await listEvaluatorTraceActivities(pool, { projectId, limit: 1 });
    expect(first).toEqual([{
      traceId,
      traceVersion: "2026-08-30T12:00:00.123456Z",
      sourceActivityAt: "2026-08-20T12:00:00.000Z",
      publishedAt: "2026-08-30T12:00:00.123456Z"
    }]);
    expect(await listEvaluatorTraceActivities(pool, {
      projectId,
      cursor: { publishedAt: first[0]!.publishedAt, traceId },
      limit: 1
    })).toEqual([]);

    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [traceId],
      sourceActivityAt: newerSourceActivity,
      activityId: "batch-newer"
    });
    expect(await listEvaluatorTraceActivities(pool, {
      projectId,
      cursor: { publishedAt: first[0]!.publishedAt, traceId },
      limit: 1
    })).toEqual([]);

    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [traceId],
      sourceActivityAt: "2026-08-19T12:00:00.000Z",
      activityId: "batch-late-older"
    });
    const reopened = await listEvaluatorTraceActivities(pool, {
      projectId,
      cursor: { publishedAt: first[0]!.publishedAt, traceId },
      limit: 1
    });
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.traceVersion).toBe(reopened[0]!.publishedAt);
    expect(reopened[0]!.sourceActivityAt).toBe("2026-08-20T12:00:00.000Z");
    expect(reopened[0]!.publishedAt > first[0]!.publishedAt).toBe(true);
  });

  it("serializes concurrent project publications into a fully pageable order", async () => {
    const traceA = `trace_${ulid()}`;
    const traceB = `trace_${ulid()}`;
    const blocker = await pool.connect();
    await blocker.query("begin");
    await blocker.query(
      "select pg_advisory_xact_lock(hashtextextended($1::text, 72819463))",
      [projectId]
    );
    const firstPublish = publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [traceA],
      sourceActivityAt: "2026-08-21T12:00:00.000Z",
      activityId: "batch-concurrent-a"
    });
    const secondPublish = publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [traceB],
      sourceActivityAt: "2026-08-21T12:00:01.000Z",
      activityId: "batch-concurrent-b"
    });
    await blocker.query("commit");
    blocker.release();
    await Promise.all([firstPublish, secondPublish]);

    const all = (await listEvaluatorTraceActivities(pool, { projectId, limit: 20 }))
      .filter((row) => row.traceId === traceA || row.traceId === traceB);
    expect(all).toHaveLength(2);
    expect(all[0]!.publishedAt < all[1]!.publishedAt).toBe(true);
    const afterFirst = await listEvaluatorTraceActivities(pool, {
      projectId,
      cursor: { publishedAt: all[0]!.publishedAt, traceId: all[0]!.traceId },
      limit: 20
    });
    expect(afterFirst.map((row) => row.traceId)).toContain(all[1]!.traceId);

    // The project high-water mark also survives clock rollback or equal clock
    // ticks across two separately committed trace publications.
    await pool.query(
      `update evaluator_trace_feed_watermarks
          set published_at = '2036-08-30T12:00:00.123456Z'::timestamptz
        where project_id = $1`,
      [projectId]
    );
    await pool.query(
      "delete from evaluator_trace_feed where project_id = $1 and trace_id = $2",
      [projectId, traceA]
    );
    const traceAfterRollback = `trace_${ulid()}`;
    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [traceAfterRollback],
      sourceActivityAt: "2026-08-21T12:00:02.000Z",
      activityId: "batch-after-clock-rollback"
    });
    const afterRollback = (await listEvaluatorTraceActivities(pool, {
      projectId,
      cursor: {
        publishedAt: "2036-08-30T12:00:00.123456Z",
        traceId: traceA
      },
      limit: 20
    })).find((row) => row.traceId === traceAfterRollback);
    expect(afterRollback?.publishedAt).toBe("2036-08-30T12:00:00.123457Z");
  });

  it("does not prune a trace that was republished after retention inspected it", async () => {
    const traceId = `trace_${ulid()}`;
    const scoreId = `score_${ulid()}`;
    const requestFingerprint = "c".repeat(64);
    const scoreReceipt = await claimEvaluatorScoreReceipt(pool, {
      projectId,
      scoreId,
      traceId,
      requestFingerprint,
      candidateBatchId: "batch_prune_score"
    });
    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [traceId],
      sourceActivityAt: "2026-08-22T12:00:00.000Z",
      activityId: "batch-prune-before"
    });
    const inspected = (await listEvaluatorTraceFeedKeys(pool, { limit: 100 }))
      .find((row) => row.traceId === traceId)!;

    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [traceId],
      sourceActivityAt: "2026-08-22T12:00:01.000Z",
      activityId: "batch-prune-after"
    });
    expect(await deleteEvaluatorTraceFeedEntries(pool, [inspected])).toBe(0);
    const current = (await listEvaluatorTraceFeedKeys(pool, { limit: 100 }))
      .find((row) => row.traceId === traceId)!;
    expect(current.traceVersion).not.toBe(inspected.traceVersion);

    expect(await deleteEvaluatorTraceFeedEntries(pool, [current])).toBe(1);
    expect((await listEvaluatorTraceFeedKeys(pool, { limit: 100 }))
      .some((row) => row.traceId === traceId)).toBe(false);
    // Score retention is keyed to the score timestamp, not trace age. Feed
    // pruning must not erase the first-write identity while that newer score
    // may still exist in ClickHouse.
    await expect(claimEvaluatorScoreReceipt(pool, {
      projectId,
      scoreId,
      traceId,
      requestFingerprint,
      candidateBatchId: "batch_prune_retry"
    })).resolves.toEqual(scoreReceipt);
  });

  it("keeps a score's first timestamp across days and rejects id reuse", async () => {
    const scoreId = `score_${ulid()}`;
    const traceId = `trace_${ulid()}`;
    const requestFingerprint = "a".repeat(64);
    await claimEvaluatorScoreReceipt(pool, {
      projectId,
      scoreId,
      traceId,
      requestFingerprint,
      candidateBatchId: "batch_score_first"
    });
    await pool.query(
      `update evaluator_score_receipts
          set score_timestamp = '2026-08-29T23:59:59.999Z'::timestamptz
        where project_id = $1 and score_id = $2`,
      [projectId, scoreId]
    );
    await expect(claimEvaluatorScoreReceipt(pool, {
      projectId,
      scoreId,
      traceId,
      requestFingerprint,
      candidateBatchId: "batch_score_retry"
    })).resolves.toEqual({
      timestamp: "2026-08-29T23:59:59.999Z",
      batchId: "batch_score_first",
      staged: false,
      materialized: false
    });
    await markEvaluatorScoreReceiptStaged(pool, {
      projectId,
      scoreId,
      batchId: "batch_score_first"
    });
    await expect(claimEvaluatorScoreReceipt(pool, {
      projectId,
      scoreId,
      traceId,
      requestFingerprint,
      candidateBatchId: "batch_score_after_stage"
    })).resolves.toMatchObject({ batchId: "batch_score_first", staged: true });
    await expect(markEvaluatorScoreReceiptMaterialized(pool, {
      projectId,
      batchId: "batch_score_first"
    })).resolves.toBe(true);
    await expect(claimEvaluatorScoreReceipt(pool, {
      projectId,
      scoreId,
      traceId,
      requestFingerprint,
      candidateBatchId: "batch_score_after_materialized"
    })).resolves.toMatchObject({ materialized: true });
    await expect(claimEvaluatorScoreReceipt(pool, {
      projectId,
      scoreId,
      traceId,
      requestFingerprint: "b".repeat(64),
      candidateBatchId: "batch_score_conflict"
    })).rejects.toBeInstanceOf(EvaluatorScoreIdempotencyConflictError);
  });

  it("stages imported snapshots with stable retries and monotonic reversions", async () => {
    const traceId = `trace_${ulid()}`;
    const runToken = `import_test_${ulid()}`;
    await claimImportRun(pool, projectId, "langfuse", runToken);
    const stage = (contentHash: string, candidateActivityId: string, candidateActivityAt: string) =>
      stageEvaluatorImportTraces(pool, {
        projectId,
        source: "langfuse",
        runToken,
        candidateActivityId,
        candidateActivityAt,
        traces: [{
          traceId,
          contentHash,
          snapshot: {
            trace: {
              id: traceId,
              projectId,
              timestamp: "2026-08-30T09:00:00.000Z",
              tags: [],
              metadata: {},
              input: { prompt: "contains\0nul" }
            },
            observations: [],
            scores: [],
            scoreActivityAt: candidateActivityAt
          }
        }]
      });
    const first = (await stage("a".repeat(64), "import_a1", "2026-08-30T12:00:00.000Z"))
      .get(traceId)!;
    expect((await listPendingEvaluatorImportTraceIds(pool, projectId, [traceId])).has(traceId))
      .toBe(true);
    await expect(claimPendingEvaluatorImportSnapshots(pool, {
      projectId,
      source: "langfuse",
      runToken
    })).resolves.toMatchObject([{ snapshot: { trace: { input: { prompt: "contains\0nul" } } } }]);
    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [traceId],
      sourceActivityAt: first.sourceActivityAt,
      activityId: first.activityId,
      importSource: "langfuse",
      importRunToken: runToken,
      importTraceTimestamp: "2026-08-30T09:00:00.000Z"
    });
    await expect(pool.query(
      `select pending, snapshot, run_token
         from evaluator_import_trace_state
        where project_id = $1 and trace_id = $2 and source = 'langfuse'`,
      [projectId, traceId]
    )).resolves.toMatchObject({
      rows: [{ pending: false, snapshot: null, run_token: null }]
    });

    const retry = (await stage("a".repeat(64), "import_a_retry", "2026-08-30T12:01:00.000Z"))
      .get(traceId)!;
    expect(retry).toEqual(first);
    await expect(claimPendingEvaluatorImportSnapshots(pool, {
      projectId,
      source: "langfuse",
      runToken
    })).resolves.toEqual([]);

    const changed = (await stage("b".repeat(64), "import_b", "2026-08-30T11:00:00.000Z"))
      .get(traceId)!;
    expect(changed.activityId).toBe("import_b");
    expect(changed.sourceActivityAt > first.sourceActivityAt).toBe(true);
    await expect(publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [traceId],
      sourceActivityAt: first.sourceActivityAt,
      activityId: first.activityId,
      importSource: "langfuse",
      importRunToken: runToken,
      importTraceTimestamp: "2026-08-30T09:00:00.000Z"
    })).rejects.toThrow("stale imported evaluator materialization");
    expect((await listPendingEvaluatorImportTraceIds(pool, projectId, [traceId])).has(traceId))
      .toBe(true);
    await publishEvaluatorTraceActivities(pool, {
      projectId,
      traceIds: [traceId],
      sourceActivityAt: changed.sourceActivityAt,
      activityId: changed.activityId,
      importSource: "langfuse",
      importRunToken: runToken,
      importTraceTimestamp: "2026-08-30T09:00:00.000Z"
    });

    const reverted = (await stage("a".repeat(64), "import_a2", "2026-08-30T10:00:00.000Z"))
      .get(traceId)!;
    expect(reverted.activityId).toBe("import_a2");
    expect(reverted.sourceActivityAt > changed.sourceActivityAt).toBe(true);

    await pool.query(
      `update import_checkpoints
          set lease_expires_at = clock_timestamp() - interval '1 second'
        where project_id = $1 and source = 'langfuse'`,
      [projectId]
    );
    const takeoverToken = `import_takeover_${ulid()}`;
    await expect(claimImportRun(pool, projectId, "langfuse", takeoverToken))
      .resolves.toMatchObject({ runToken: takeoverToken });
    await expect(stage("c".repeat(64), "import_stale", "2026-08-30T13:00:00.000Z"))
      .rejects.toThrow("import run lease was lost");
    await expect(claimPendingEvaluatorImportSnapshots(pool, {
      projectId,
      source: "langfuse",
      runToken: takeoverToken
    })).resolves.toEqual([
      expect.objectContaining({
        traceId,
        activityId: reverted.activityId,
        sourceActivityAt: reverted.sourceActivityAt
      })
    ]);
  });
});
