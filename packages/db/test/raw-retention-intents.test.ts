import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";
import {
  claimRawRetentionIntentExecution,
  completeRawRetentionIntent,
  createRawRetentionIntents,
  getRawRetentionIntent,
  getRawRetentionIntentsByIds,
  listRawRetentionIntents,
  recordRawRetentionIntentError,
  tryWithRawRetentionObjectLock,
  withRawRetentionExecutionLock,
  withRawRetentionObjectLock
} from "../src/raw-retention-intents.js";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://ironside:ironside@localhost:5433/ironside"
});

const projectId = `proj_${ulid()}`;
const preparationId = `rtp_${ulid()}`;

beforeAll(async () => {
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.query("delete from raw_retention_intents where project_id = $1", [projectId]);
  await pool.end();
});

describe("raw retention intents", () => {
  it("atomically creates bounded metadata-only intents and keeps conflicts unchanged", async () => {
    const input = {
      id: `rti_${ulid()}`,
      preparationId,
      projectId,
      ingestBatchId: "batch_1",
      objectKey: `raw/${projectId}/2025/01/01/batch_1.json`,
      objectSizeBytes: 123,
      retentionCutoffDay: "2026-01-01",
      effectiveRetentionDays: 90,
      traceIds: ["trace_1", "trace_2"],
      classification: "applied" as const,
      diagnosticCount: 2
    };

    const inserted = await createRawRetentionIntents(pool, [input]);
    const duplicate = await createRawRetentionIntents(pool, [
      { ...input, id: `rti_${ulid()}`, objectSizeBytes: 999 }
    ]);

    expect(inserted).toHaveLength(1);
    expect(duplicate).toEqual([]);
    expect(await getRawRetentionIntent(pool, projectId, input.objectKey)).toMatchObject({
      id: input.id,
      objectSizeBytes: 123,
      traceIds: ["trace_1", "trace_2"],
      classification: "applied",
      state: "prepared",
      attempts: 0,
      lastError: null
    });
    expect(await listRawRetentionIntents(pool, projectId, "prepared", 1)).toHaveLength(1);

    expect(await getRawRetentionIntentsByIds(pool, projectId, [input.id])).toHaveLength(1);
    const claimed = await claimRawRetentionIntentExecution(pool, projectId, input.id);
    expect(claimed).toMatchObject({ state: "executing", attempts: 1 });
    await recordRawRetentionIntentError(pool, projectId, input.id, "retry me");
    expect(await getRawRetentionIntent(pool, projectId, input.objectKey)).toMatchObject({
      state: "executing",
      lastError: "retry me"
    });
    expect(await completeRawRetentionIntent(pool, projectId, input.id)).toBe(true);
    expect(await getRawRetentionIntent(pool, projectId, input.objectKey)).toMatchObject({
      state: "complete",
      lastError: null
    });
  });

  it("holds execution and per-object advisory locks on pinned sessions", async () => {
    let secondAcquired = true;
    const first = await withRawRetentionExecutionLock(pool, async () => {
      const second = await withRawRetentionExecutionLock(pool, async () => "unexpected");
      secondAcquired = second.acquired;
      return "held";
    });
    expect(first).toEqual({ acquired: true, value: "held" });
    expect(secondAcquired).toBe(false);

    const order: string[] = [];
    let signalFirstAcquired!: () => void;
    let releaseFirst!: () => void;
    const firstAcquired = new Promise<void>((resolve) => {
      signalFirstAcquired = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstObjectLock = withRawRetentionObjectLock(
      pool,
      projectId,
      "raw/locked.json",
      async () => {
        order.push("first-start");
        expect(
          await tryWithRawRetentionObjectLock(
            pool,
            projectId,
            "raw/locked.json",
            async () => "unexpected"
          )
        ).toEqual({ acquired: false });
        signalFirstAcquired();
        await holdFirst;
        order.push("first-end");
      }
    );
    await firstAcquired;
    const secondObjectLock = withRawRetentionObjectLock(
      pool,
      projectId,
      "raw/locked.json",
      async () => {
        order.push("second");
      }
    );
    releaseFirst();
    await Promise.all([firstObjectLock, secondObjectLock]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});
