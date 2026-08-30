import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeEvaluatorLifecycleFence,
  withEvaluatorDataWriteFence,
  withEvaluatorRetentionFence
} from "../src/evaluator-lifecycle-fence.js";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://ironside:ironside@localhost:5433/ironside",
  max: 4
});

afterAll(async () => {
  await closeEvaluatorLifecycleFence(pool);
  await pool.end();
});

describe("evaluator lifecycle fence", () => {
  it("allows concurrent writers while retention waits for every writer", async () => {
    let releaseWriters!: () => void;
    const writersReleased = new Promise<void>((resolve) => {
      releaseWriters = resolve;
    });
    let writersEntered = 0;
    let bothWritersEntered!: () => void;
    const bothWriters = new Promise<void>((resolve) => {
      bothWritersEntered = resolve;
    });
    const writer = () => withEvaluatorDataWriteFence(pool, async () => {
      writersEntered += 1;
      if (writersEntered === 2) bothWritersEntered();
      await writersReleased;
    });

    const first = writer();
    const second = writer();
    await bothWriters;

    let retentionEntered = false;
    const retention = withEvaluatorRetentionFence(pool, async () => {
      retentionEntered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(retentionEntered).toBe(false);

    releaseWriters();
    await Promise.all([first, second, retention]);
    expect(retentionEntered).toBe(true);
  });
});
