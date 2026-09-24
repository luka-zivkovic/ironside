import type { ClickHouseClient } from "@ironside/clickhouse";
import {
  getRawRetentionIntentsForObjects,
  listAllProjects,
  listRawRetentionIntentsAfter,
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
/** Error messages kept per sweep; the rest are only counted. */
const MAX_REPORTED_ERRORS = 20;

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

/** Carried between sweeps in worker memory; a restart only restarts the cycle. */
export interface RawRetentionSweepState {
  /** Per project: the last raw key handled, so the next sweep continues after it. */
  cursors: Map<string, string>;
  /** Per project: the last `executing` intent resumed, so blocked ones cannot hold the head of the list. */
  executingCursors: Map<string, string>;
  /** Rotates which project a sweep starts with, so a shared deadline cannot starve later projects. */
  projectOffset: number;
}

export interface RawRetentionSweepResult {
  /** Raw objects past their project's retention cutoff that the sweep handled. */
  examined: number;
  prepared: number;
  deleted: number;
  /** Intents the executor declined this time (for example, a trace still visible); they are retried in a later cycle. */
  blocked: number;
  /** Objects the preparer declined (for example, still referenced by a visible trace); revisited in a later cycle. */
  skipped: number;
  /** Another replica held the execution lock, so this sweep stopped early. */
  lockBusy: boolean;
  /** Failures, bounded: a project that failed is left for the next sweep; an object or intent that failed on its own is skipped until the next cycle. */
  errors: { projectId: string; message: string }[];
  errorCount: number;
}

export function createRawRetentionSweepState(): RawRetentionSweepState {
  return { cursors: new Map(), executingCursors: new Map(), projectOffset: 0 };
}

/** Another replica holds the executor's cross-replica lock; the sweep yields to it. */
class LockBusy extends Error {}

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
 *
 * Failures stay local: a project that fails is recorded and left for the
 * next sweep, and a page the preparer or executor rejects (for example, over
 * its aggregate trace-reference cap) is split until single objects remain.
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
    lockBusy: false,
    errors: [],
    errorCount: 0
  };
  const now = options.now ?? new Date();
  const deadline = Date.now() + (options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
  const projects = (await listAllProjects(options.pool)).filter(
    (project) => !options.projectIds || options.projectIds.includes(project.id)
  );
  if (projects.length === 0) return result;
  const start = state.projectOffset % projects.length;
  state.projectOffset = (start + 1) % projects.length;

  for (const project of [...projects.slice(start), ...projects.slice(0, start)]) {
    if (Date.now() >= deadline) break;
    const retentionDays = project.retentionDays ?? options.defaultRetentionDays;
    const cutoffDay = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    try {
      await sweepProject(options, state, result, { projectId: project.id, cutoffDay, now, deadline });
    } catch (error) {
      if (error instanceof LockBusy) {
        result.lockBusy = true;
        return result;
      }
      recordError(result, project.id, error);
    }
  }
  return result;
}

async function sweepProject(
  options: RawRetentionSweepOptions,
  state: RawRetentionSweepState,
  result: RawRetentionSweepResult,
  run: { projectId: string; cutoffDay: string; now: Date; deadline: number }
): Promise<void> {
  const { projectId } = run;

  // A crash can leave an intent mid-execution after its raw object is gone,
  // where discovery would never find it again. Resume those first, rotating
  // through them so permanently blocked ones cannot hold the head.
  const executing = await listRawRetentionIntentsAfter(
    options.pool,
    projectId,
    "executing",
    state.executingCursors.get(projectId) ?? null,
    RAW_RETENTION_PREPARATION_MAX_OBJECTS
  );
  if (executing.length < RAW_RETENTION_PREPARATION_MAX_OBJECTS) state.executingCursors.delete(projectId);
  else state.executingCursors.set(projectId, executing.at(-1)!.id);
  await execute(options, result, run, executing.map((intent) => intent.id));

  const maxPerProject = options.maxObjectsPerProject ?? DEFAULT_MAX_OBJECTS_PER_PROJECT;
  let examinedForProject = 0;
  while (examinedForProject < maxPerProject && Date.now() < run.deadline) {
    const page = await listExpiredRawObjects(
      options.storage,
      projectId,
      run.cutoffDay,
      state.cursors.get(projectId),
      Math.min(RAW_RETENTION_PREPARATION_MAX_OBJECTS, maxPerProject - examinedForProject)
    );
    if (page.keys.length > 0) {
      const existing = await getRawRetentionIntentsForObjects(options.pool, projectId, page.keys);
      const intentIds = [...existing.values()]
        .filter((intent) => intent.state !== "complete")
        .map((intent) => intent.id);
      const unprepared = page.keys.filter((key) => !existing.has(key));
      intentIds.push(...(await prepare(options, result, run, unprepared)));
      await execute(options, result, run, intentIds);
      examinedForProject += page.keys.length;
      result.examined += page.keys.length;
    }
    // Only now, with the page handled, move past it.
    if (page.reachedCutoff) state.cursors.delete(projectId);
    else if (page.lastKey) state.cursors.set(projectId, page.lastKey);
    if (page.reachedCutoff || page.keys.length === 0) break;
  }
}

/**
 * Prepares keys, splitting the set whenever the preparer rejects it as a
 * whole, down to single keys. A single key that still fails is recorded and
 * skipped until the next cycle. When every key failed on its own, the cause
 * is shared (a store outage, most likely), so the error propagates and the
 * project's cursor stays put.
 */
async function prepare(
  options: RawRetentionSweepOptions,
  result: RawRetentionSweepResult,
  run: { projectId: string; now: Date },
  keys: string[]
): Promise<string[]> {
  const outcome = await splitOnFailure(keys, async (subset) => {
    const preparation = await prepareRawRetentionIntents({
      pool: options.pool,
      clickhouse: options.clickhouse,
      storage: options.storage,
      queue: options.queue,
      projectId: run.projectId,
      objectKeys: subset,
      defaultRetentionDays: options.defaultRetentionDays,
      now: run.now
    });
    result.prepared += preparation.prepared.length;
    result.skipped += preparation.skipped.length;
    return preparation.prepared.map((prepared) => prepared.intentId);
  });
  settleFailures(result, run.projectId, keys.length, outcome.failures);
  return outcome.values;
}

/** Runs intents through the executor in its maximum chunk size, splitting a chunk it rejects as a whole. */
async function execute(
  options: RawRetentionSweepOptions,
  result: RawRetentionSweepResult,
  run: { projectId: string; now: Date },
  intentIds: string[]
): Promise<void> {
  for (let start = 0; start < intentIds.length; start += RAW_RETENTION_EXECUTION_MAX_INTENTS) {
    const chunk = intentIds.slice(start, start + RAW_RETENTION_EXECUTION_MAX_INTENTS);
    const outcome = await splitOnFailure(chunk, async (subset) => {
      const execution = await executeRawRetentionIntents({
        pool: options.pool,
        clickhouse: options.clickhouse,
        storage: options.storage,
        queue: options.queue,
        projectId: run.projectId,
        intentIds: subset,
        defaultRetentionDays: options.defaultRetentionDays,
        executionEnabled: true,
        confirmation: "execute",
        now: run.now
      });
      if (!execution.lockAcquired) throw new LockBusy("raw retention execution lock is held elsewhere");
      result.deleted += execution.completed.length;
      result.blocked += execution.blocked.length;
      return [];
    });
    settleFailures(result, run.projectId, chunk.length, outcome.failures);
  }
}

/**
 * Applies `operation` to `items`; on failure, halves the set and retries each
 * half, so one oversized or broken member cannot sink the rest. LockBusy is
 * never split: it aborts the sweep.
 */
async function splitOnFailure<T>(
  items: string[],
  operation: (subset: string[]) => Promise<T[]>
): Promise<{ values: T[]; failures: { item: string; error: unknown }[] }> {
  if (items.length === 0) return { values: [], failures: [] };
  try {
    return { values: await operation(items), failures: [] };
  } catch (error) {
    if (error instanceof LockBusy) throw error;
    if (items.length === 1) return { values: [], failures: [{ item: items[0]!, error }] };
    const middle = Math.ceil(items.length / 2);
    const [left, right] = [
      await splitOnFailure(items.slice(0, middle), operation),
      await splitOnFailure(items.slice(middle), operation)
    ];
    return { values: [...left.values, ...right.values], failures: [...left.failures, ...right.failures] };
  }
}

/** Records per-item failures, or propagates when every item failed (a shared cause). */
function settleFailures(
  result: RawRetentionSweepResult,
  projectId: string,
  total: number,
  failures: { item: string; error: unknown }[]
): void {
  if (failures.length === 0) return;
  if (failures.length === total) throw failures[0]!.error;
  for (const failure of failures) {
    recordError(result, projectId, `${failure.item}: ${errorMessage(failure.error)}`);
  }
}

function recordError(result: RawRetentionSweepResult, projectId: string, error: unknown): void {
  result.errorCount += 1;
  if (result.errors.length < MAX_REPORTED_ERRORS) {
    result.errors.push({ projectId, message: errorMessage(error) });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
