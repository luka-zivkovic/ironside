import {
  dropPartitionsOlderThan,
  listExistingTraceIds,
  markChildrenOfExpiredTracesDeleted,
  markProjectDataDeletedOlderThan,
  recordExpiredEvaluatorTraceIds,
  type ClickHouseClient,
  type RetainedTable
} from "@ironside/clickhouse";
import {
  deleteEvaluatorTraceFeedEntries,
  ensureEvaluatorImportRetentionCutoffs,
  listAllProjects,
  listEvaluatorTraceFeedKeys,
  purgeIngestFailuresOlderThan,
  recordEvaluatorImportRetentionCutoffs,
  withEvaluatorRetentionFence
} from "@ironside/db";
import type { Pool } from "pg";

const RETAINED_TABLES: readonly RetainedTable[] = ["traces", "observations", "scores"];

export interface RunRetentionOptions {
  pool: Pool;
  clickhouse: ClickHouseClient;
  /** Platform-default retention window in days, used for projects with no `retentionDays` override. */
  defaultRetentionDays: number;
  /** Fixed clock for one pass; callers normally omit it, tests can make cutoffs deterministic. */
  now?: Date;
}

export interface RetentionRunResult {
  /** Global partition drops — the primary "drop CH partitions" mechanism the DoD names, applied at the OLDEST (most conservative) retention floor across every project, since a partition holds every project's rows for that month. */
  droppedPartitions: Record<RetainedTable, string[]>;
  /** Per-project row-level deletes, only for projects whose retentionDays override is SHORTER than the global floor a partition drop already enforced. */
  projectDeletes: { projectId: string; retentionDays: number }[];
  /** Dead-letter diagnostics rows purged from ingest_event_failures (M9-03) — fixed 30-day window, so the table can't grow unbounded. */
  purgedIngestFailures: number;
  /** Durable evaluator rows whose ClickHouse trace was removed by retention. */
  prunedEvaluatorTraceFeed: number;
}

/**
 * Establishes the durable import cutoff before scheduled pull imports are
 * allowed to run. This is deliberately separate from the destructive
 * retention sweep: after an upgrade, the cutoff table starts empty while the
 * provider checkpoint can still point at an already-retained boundary row.
 */
export async function seedEvaluatorImportRetentionCutoffs(options: {
  pool: Pool;
  defaultRetentionDays: number;
  now?: Date;
}): Promise<void> {
  const projects = await listAllProjects(options.pool);
  await ensureEvaluatorImportRetentionCutoffs(
    options.pool,
    cutoffEntries(
      projects,
      options.defaultRetentionDays,
      options.now ?? new Date()
    )
  );
}

async function recordCutoffsForProjects(
  pool: Pool,
  projects: Awaited<ReturnType<typeof listAllProjects>>,
  defaultRetentionDays: number,
  now: Date
): Promise<void> {
  await recordEvaluatorImportRetentionCutoffs(pool, cutoffEntries(projects, defaultRetentionDays, now));
}

function cutoffEntries(
  projects: Awaited<ReturnType<typeof listAllProjects>>,
  defaultRetentionDays: number,
  now: Date
): Array<{ projectId: string; traceTimestampBefore: string }> {
  return projects.map((project) => ({
    projectId: project.id,
    traceTimestampBefore: daysAgo(
      project.retentionDays ?? defaultRetentionDays,
      now
    ).toISOString()
  }));
}

/**
 * Runs one retention pass: drops whole ClickHouse partitions older than
 * the LOOSEST retention window in effect (the platform default, or any
 * project's override if longer — see below for why), then applies
 * row-level per-project deletion for any project whose own retention is
 * SHORTER than that floor.
 *
 * Partitions are calendar-month and NOT project-scoped (packages/clickhouse
 * partitions by toYYYYMM(timestamp) across every project sharing that
 * month) — see packages/clickhouse/src/retention.ts's docstring. This
 * means the partition-drop mechanism can only enforce a single GLOBAL
 * cutoff: it must use the LONGEST retention any project needs (the
 * platform default, or a project override that's longer than default),
 * because dropping a partition that still holds a project's
 * still-in-window data would violate that project's retention promise.
 * Projects wanting SHORTER retention than that floor get the extra
 * precision via row-level markProjectDataDeletedOlderThan instead.
 */
export async function runRetention(options: RunRetentionOptions): Promise<RetentionRunResult> {
  return withEvaluatorRetentionFence(options.pool, () => runRetentionFenced(options));
}

async function runRetentionFenced(options: RunRetentionOptions): Promise<RetentionRunResult> {
  const { pool, clickhouse } = options;

  const projects = await listAllProjects(pool);
  const globalFloorDays = Math.max(
    options.defaultRetentionDays,
    ...projects.map((p) => p.retentionDays ?? 0)
  );
  const now = options.now ?? new Date();
  const globalCutoff = daysAgo(globalFloorDays, now);

  // Publish the monotonic cutoff before deleting ClickHouse rows. Inclusive
  // provider checkpoints can otherwise reinsert an expired trace between the
  // delete and the next poll. Import materialization rechecks this ledger
  // after its writes, so either side of the race converges to deletion.
  await recordCutoffsForProjects(pool, projects, options.defaultRetentionDays, now);

  // Whole-trace retention is parent-owned. Remove every child of an expired
  // parent before any trace partition/drop or row tombstone makes the parent
  // identity unavailable; a recent assessment must not outlive its trace.
  const traceCutoffs = projects.map((project) => ({
      projectId: project.id,
      traceOlderThan: daysAgo(
        project.retentionDays ?? options.defaultRetentionDays,
        now
      )
    }));
  await recordExpiredEvaluatorTraceIds(clickhouse, traceCutoffs);

  const droppedPartitions: Record<RetainedTable, string[]> = { traces: [], observations: [], scores: [] };
  for (const table of RETAINED_TABLES) {
    droppedPartitions[table] = await dropPartitionsOlderThan(clickhouse, table, globalCutoff);
  }

  // Row-level deletion only runs for projects with an EXPLICIT override
  // shorter than the global floor — not for every project sitting at the
  // platform default, even though those are also, strictly, "below the
  // floor" once some other project's long override raises it. Extending
  // this to every default-retention project would make one project's
  // long-retention override force a full per-project ClickHouse
  // INSERT...SELECT mutation for every OTHER project on the platform on
  // every retention run — a real hang was observed in testing with just
  // ~35 projects. Default-retention projects' old data still eventually
  // gets removed once the floor itself comes back down (the long
  // override expires/changes) via a normal partition drop; there is no
  // retention-promise violation in the meantime, since the platform
  // default was never violated — only projects that asked for something
  // SHORTER than default need the extra row-level precision.
  const projectDeletes: RetentionRunResult["projectDeletes"] = [];
  for (const project of projects) {
    if (project.retentionDays === null) continue;
    if (project.retentionDays >= globalFloorDays) continue;

    const projectCutoff = daysAgo(project.retentionDays, now);
    for (const table of RETAINED_TABLES) {
      await markProjectDataDeletedOlderThan(clickhouse, table, project.id, projectCutoff);
    }
    projectDeletes.push({ projectId: project.id, retentionDays: project.retentionDays });
  }

  // Markers are policy candidates, while partition grace/global-floor rules
  // decide whether a parent was actually removed in this pass. Only after all
  // trace deletion paths complete do we remove children whose parent is no
  // longer live; still-visible trees remain immutable.
  await markChildrenOfExpiredTracesDeleted(
    clickhouse,
    projects.map((project) => project.id)
  );

  // Dead-letter rows are diagnostics, not trace data — a fixed 30-day
  // window (not the per-project retention settings) keeps the table
  // bounded without inventing a separate config knob for it.
  const purgedIngestFailures = await purgeIngestFailuresOlderThan(pool, 30);
  // Reconcile on every pass. A prior run may have deleted ClickHouse traces
  // and then crashed before feed cleanup; conditioning this on deletions from
  // only the current run would strand those durable orphans indefinitely.
  const prunedEvaluatorTraceFeed = await pruneOrphanedEvaluatorTraceFeed(pool, clickhouse);

  return { droppedPartitions, projectDeletes, purgedIngestFailures, prunedEvaluatorTraceFeed };
}

const EVALUATOR_FEED_PRUNE_BATCH_SIZE = 500;

async function pruneOrphanedEvaluatorTraceFeed(
  pool: Pool,
  clickhouse: ClickHouseClient
): Promise<number> {
  let after: { projectId: string; traceId: string } | undefined;
  let pruned = 0;
  while (true) {
    const page = await listEvaluatorTraceFeedKeys(pool, {
      ...(after ? { after } : {}),
      limit: EVALUATOR_FEED_PRUNE_BATCH_SIZE
    });
    if (page.length === 0) break;

    const byProject = new Map<string, typeof page>();
    for (const entry of page) {
      const entries = byProject.get(entry.projectId) ?? [];
      entries.push(entry);
      byProject.set(entry.projectId, entries);
    }
    const orphaned: typeof page = [];
    for (const [projectId, entries] of byProject) {
      const traceIds = entries.map((entry) => entry.traceId);
      const existing = await listExistingTraceIds(clickhouse, projectId, traceIds);
      for (const entry of entries) {
        if (!existing.has(entry.traceId)) orphaned.push(entry);
      }
    }
    // Deletion is version-guarded. If an ingest republishes between the
    // ClickHouse existence check and this write, the fresh feed row wins.
    pruned += await deleteEvaluatorTraceFeedEntries(pool, orphaned);
    after = page.at(-1);
    if (page.length < EVALUATOR_FEED_PRUNE_BATCH_SIZE) break;
  }
  return pruned;
}

function daysAgo(days: number, now: Date): Date {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}
