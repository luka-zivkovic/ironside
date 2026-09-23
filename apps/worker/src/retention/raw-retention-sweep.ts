import type { ClickHouseClient } from "@ironside/clickhouse";
import {
  getRawRetentionIntentsForObjects,
  listAllProjects,
  listRawRetentionIntents,
  RAW_RETENTION_EXECUTION_MAX_INTENTS,
  RAW_RETENTION_PREPARATION_MAX_OBJECTS
} from "@ironside/db";
import { parseRawObjectKey, type QueueMessage } from "@ironside/shared";
import type { ObjectStorage } from "@ironside/storage";
import type { Queue } from "bullmq";
import type { Pool } from "pg";
import { executeRawRetentionIntents } from "./raw-retention-intent-executor.js";
import { prepareRawRetentionIntents } from "./raw-retention-intent-preparer.js";

const DEFAULT_MAX_OBJECTS_PER_PROJECT = 1_000;
const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

export interface RawRetentionSweepOptions {
  pool: Pool;
  clickhouse: ClickHouseClient;
  storage: ObjectStorage;
  queue: Queue<QueueMessage>;
  defaultRetentionDays: number;
  /** Raw objects examined per project in one sweep. */
  maxObjectsPerProject?: number;
  /** A sweep stops starting new work after this long; the next one continues where it left off. */
  maxDurationMs?: number;
  /** Limits the sweep to these projects; every project when absent. */
  projectIds?: string[];
  now?: Date;
}

/** Carried between sweeps: per project, the last raw key examined. */
export interface RawRetentionSweepState {
  cursors: Map<string, string>;
}

export interface RawRetentionSweepResult {
  /** Raw objects past their project's retention cutoff that the sweep looked at. */
  examined: number;
  prepared: number;
  deleted: number;
  /** Intents the executor declined this time (for example, a trace still visible); they are retried in a later cycle. */
  blocked: number;
  /** Objects the preparer declined (for example, still referenced by a visible trace); revisited in a later cycle. */
  skipped: number;
  /** Another replica held the execution lock, so this sweep stopped early. */
  lockBusy: boolean;
}

export function createRawRetentionSweepState(): RawRetentionSweepState {
  return { cursors: new Map() };
}

/**
 * Deletes raw event objects once their UTC day is past the project's
 * retention cutoff (spec/raw-retention-intents-v1.md). It only discovers
 * candidates: every object still goes through prepareRawRetentionIntents and
 * executeRawRetentionIntents, so every safety check of the operator path
 * applies, and anything uncertain is skipped rather than deleted.
 *
 * Discovery walks each project's `raw/{project}/{yyyy}/{mm}/{dd}/` keys in
 * day order from a per-project cursor, up to the cutoff. Reaching the cutoff
 * clears the cursor, so the next sweep starts over and revisits objects that
 * were skipped for a reason that has since cleared. The bounded budget keeps
 * one sweep short even when many objects are skipped permanently.
 */
export async function runRawRetentionSweep(
  options: RawRetentionSweepOptions,
  state: RawRetentionSweepState
): Promise<RawRetentionSweepResult> {
  const result: RawRetentionSweepResult = {
    examined: 0,
    prepared: 0,
    deleted: 0,
    blocked: 0,
    skipped: 0,
    lockBusy: false
  };
  const now = options.now ?? new Date();
  const deadline = Date.now() + (options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
  const maxPerProject = options.maxObjectsPerProject ?? DEFAULT_MAX_OBJECTS_PER_PROJECT;

  const projects = (await listAllProjects(options.pool)).filter(
    (project) => !options.projectIds || options.projectIds.includes(project.id)
  );
  for (const project of projects) {
    if (Date.now() >= deadline) break;
    const projectId = project.id;
    const retentionDays = project.retentionDays ?? options.defaultRetentionDays;
    const cutoffDay = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    // A crash can leave an intent mid-execution after its raw object is gone,
    // where discovery would never find it again. Resume those first.
    const executing = await listRawRetentionIntents(
      options.pool,
      projectId,
      "executing",
      RAW_RETENTION_PREPARATION_MAX_OBJECTS
    );
    if (!(await execute(options, projectId, executing.map((intent) => intent.id), now, result))) {
      return result;
    }

    let examinedForProject = 0;
    while (examinedForProject < maxPerProject && Date.now() < deadline) {
      const page = await listExpiredRawObjects(
        options.storage,
        projectId,
        cutoffDay,
        state.cursors.get(projectId),
        Math.min(RAW_RETENTION_PREPARATION_MAX_OBJECTS, maxPerProject - examinedForProject)
      );
      if (page.reachedCutoff) state.cursors.delete(projectId);
      else if (page.lastKey) state.cursors.set(projectId, page.lastKey);
      if (page.keys.length === 0) break;
      examinedForProject += page.keys.length;
      result.examined += page.keys.length;

      const existing = await getRawRetentionIntentsForObjects(options.pool, projectId, page.keys);
      const intentIds = [...existing.values()]
        .filter((intent) => intent.state !== "complete")
        .map((intent) => intent.id);
      const unprepared = page.keys.filter((key) => !existing.has(key));
      if (unprepared.length > 0) {
        const preparation = await prepareRawRetentionIntents({
          pool: options.pool,
          clickhouse: options.clickhouse,
          storage: options.storage,
          queue: options.queue,
          projectId,
          objectKeys: unprepared,
          defaultRetentionDays: options.defaultRetentionDays,
          now
        });
        result.prepared += preparation.prepared.length;
        result.skipped += preparation.skipped.length;
        intentIds.push(...preparation.prepared.map((prepared) => prepared.intentId));
      }
      if (!(await execute(options, projectId, intentIds, now, result))) return result;
      if (page.reachedCutoff) break;
    }
  }
  return result;
}

/** Runs intents through the executor in its maximum chunk size. False when another replica holds the lock. */
async function execute(
  options: RawRetentionSweepOptions,
  projectId: string,
  intentIds: string[],
  now: Date,
  result: RawRetentionSweepResult
): Promise<boolean> {
  for (let start = 0; start < intentIds.length; start += RAW_RETENTION_EXECUTION_MAX_INTENTS) {
    const execution = await executeRawRetentionIntents({
      pool: options.pool,
      clickhouse: options.clickhouse,
      storage: options.storage,
      queue: options.queue,
      projectId,
      intentIds: intentIds.slice(start, start + RAW_RETENTION_EXECUTION_MAX_INTENTS),
      defaultRetentionDays: options.defaultRetentionDays,
      executionEnabled: true,
      confirmation: "execute",
      now
    });
    if (!execution.lockAcquired) {
      result.lockBusy = true;
      return false;
    }
    result.deleted += execution.completed.length;
    result.blocked += execution.blocked.length;
  }
  return true;
}

/**
 * Canonical raw keys for days strictly before `cutoffDay`, in day order.
 * Keys sort chronologically because the path is raw/{project}/yyyy/mm/dd/.
 * Non-canonical keys, such as the executor's .retention-probes objects, are
 * passed over.
 */
async function listExpiredRawObjects(
  storage: ObjectStorage,
  projectId: string,
  cutoffDay: string,
  startAfter: string | undefined,
  limit: number
): Promise<{ keys: string[]; lastKey: string | undefined; reachedCutoff: boolean }> {
  const keys: string[] = [];
  let lastKey: string | undefined;
  for await (const key of storage.list(`raw/${projectId}/`, startAfter ? { startAfter } : undefined)) {
    const parsed = parseRawObjectKey(key);
    if (parsed?.projectId === projectId && parsed.day >= cutoffDay) {
      return { keys, lastKey, reachedCutoff: true };
    }
    lastKey = key;
    if (parsed?.projectId !== projectId) continue;
    keys.push(key);
    if (keys.length >= limit) return { keys, lastKey, reachedCutoff: false };
  }
  return { keys, lastKey, reachedCutoff: true };
}

export interface RawRetentionSweepLoop {
  stop(): void;
}

/** Runs a sweep now and then every `intervalMs`, never overlapping itself. */
export function startRawRetentionSweep(
  options: RawRetentionSweepOptions & {
    intervalMs?: number;
    onResult?: (result: RawRetentionSweepResult) => void;
    onError?: (error: unknown) => void;
  }
): RawRetentionSweepLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new Error("raw retention sweep intervalMs must be positive");
  }
  const state = createRawRetentionSweepState();
  let stopped = false;
  let running = false;
  async function tick(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      options.onResult?.(await runRawRetentionSweep(options, state));
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}
