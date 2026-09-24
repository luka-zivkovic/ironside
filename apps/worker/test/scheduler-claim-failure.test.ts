import type { ClickHouseClient } from "@ironside/clickhouse";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { startScheduler, type Scheduler } from "../src/scheduler.js";

let scheduler: Scheduler | undefined;
afterEach(() => scheduler?.stop());

describe("scheduler with Postgres unreachable", () => {
  it("reports each destination subsystem's failed claim instead of raising an unhandled rejection", async () => {
    const down = () => Promise.reject(new Error("postgres down"));
    const pool = { query: down, connect: down } as unknown as Pool;
    const errors: string[] = [];
    const outcomes: string[] = [];

    scheduler = startScheduler({
      pool,
      clickhouse: {} as ClickHouseClient,
      defaultRetentionDays: 90,
      tickIntervalMs: 60_000,
      retentionIntervalMs: 3_600_000,
      onError: (subsystem) => errors.push(subsystem),
      onRunOutcome: (subsystem, outcome) => outcomes.push(`${subsystem}:${outcome}`)
    });

    await expect.poll(() => errors.filter((subsystem) => ["export", "otlp-forward", "webhook"].includes(subsystem))).toEqual([
      "export",
      "otlp-forward",
      "webhook"
    ]);
    expect(outcomes).toEqual(expect.arrayContaining(["export:error", "otlp-forward:error", "webhook:error"]));
  });
});
