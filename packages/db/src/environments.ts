import {
  MAX_OBSERVED_ENVIRONMENTS_PER_PROJECT,
  normalizeEnvironment
} from "@ironside/shared";
import type { Pool, PoolClient } from "pg";

const ENVIRONMENT_LOCK_NAMESPACE = 660066;
const REBUILD_LEASE_MINUTES = 5;
const REBUILD_INTERVAL_HOURS = 24;

export interface EnvironmentObservation {
  environment: string;
  traceTimestamp: string | Date;
}

export interface ProjectEnvironmentRecord {
  projectId: string;
  name: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  hidden: boolean;
  /** Trace-observation watermark used only to protect concurrent discovery. */
  updatedAt: Date;
}

export interface ProjectEnvironmentRegistry {
  environments: ProjectEnvironmentRecord[];
  overflowed: boolean;
  lastOverflowAt: Date | null;
  lastRebuiltAt: Date | null;
}

export interface ObserveProjectEnvironmentsResult {
  admitted: number;
  overflowed: number;
}

interface EnvironmentRow {
  project_id: string;
  name: string;
  first_seen_at: Date;
  last_seen_at: Date;
  hidden: boolean;
  updated_at: Date;
}

interface EnvironmentRebuildRow extends EnvironmentRow {
  /** Compared by Postgres so sub-millisecond ordering is not lost in JS Date. */
  post_watermark: boolean;
}

interface RegistryStateRow {
  overflowed: boolean;
  last_overflow_at: Date | null;
  last_rebuilt_at: Date | null;
}

function fromRow(row: EnvironmentRow): ProjectEnvironmentRecord {
  return {
    projectId: row.project_id,
    name: row.name,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    hidden: row.hidden,
    updatedAt: row.updated_at
  };
}

async function lockProject(client: PoolClient, projectId: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, $2))", [
    projectId,
    ENVIRONMENT_LOCK_NAMESPACE
  ]);
}

function mergeObservations(
  observations: EnvironmentObservation[]
): Array<{ name: string; firstSeenAt: Date; lastSeenAt: Date }> {
  const merged = new Map<string, { firstSeenAt: Date; lastSeenAt: Date }>();
  for (const observation of observations) {
    const name = normalizeEnvironment(observation.environment);
    const timestamp =
      observation.traceTimestamp instanceof Date
        ? observation.traceTimestamp
        : new Date(observation.traceTimestamp);
    if (name === null || Number.isNaN(timestamp.getTime())) continue;
    const existing = merged.get(name);
    if (!existing) {
      merged.set(name, { firstSeenAt: timestamp, lastSeenAt: timestamp });
      continue;
    }
    if (timestamp < existing.firstSeenAt) existing.firstSeenAt = timestamp;
    if (timestamp > existing.lastSeenAt) existing.lastSeenAt = timestamp;
  }
  return [...merged.entries()].map(([name, seen]) => ({ name, ...seen }));
}

/**
 * At-least-once-safe live projection update. One advisory lock serializes
 * admission, visibility changes, and rebuild swaps for a project so the
 * fixed cap cannot be exceeded by concurrent workers.
 */
export async function observeProjectEnvironments(
  pool: Pool,
  projectId: string,
  observations: EnvironmentObservation[]
): Promise<ObserveProjectEnvironmentsResult> {
  const incoming = mergeObservations(observations);
  if (incoming.length === 0) return { admitted: 0, overflowed: 0 };

  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockProject(client, projectId);

    const existingResult = await client.query<{ name: string }>(
      "select name from project_environments where project_id = $1",
      [projectId]
    );
    const existing = new Set(existingResult.rows.map((row) => row.name));

    const names = incoming.map((item) => item.name);
    const firstSeen = incoming.map((item) => item.firstSeenAt);
    const lastSeen = incoming.map((item) => item.lastSeenAt);
    await client.query(
      `with incoming(name, first_seen_at, last_seen_at) as (
         select * from unnest($2::text[], $3::timestamptz[], $4::timestamptz[])
       )
       update project_environments as environment
          set first_seen_at = least(environment.first_seen_at, incoming.first_seen_at),
              last_seen_at = greatest(environment.last_seen_at, incoming.last_seen_at),
              updated_at = clock_timestamp()
         from incoming
        where environment.project_id = $1 and environment.name = incoming.name`,
      [projectId, names, firstSeen, lastSeen]
    );

    const capacity = Math.max(
      0,
      MAX_OBSERVED_ENVIRONMENTS_PER_PROJECT - existing.size
    );
    const novel = incoming
      .filter((item) => !existing.has(item.name))
      .sort(
        (a, b) =>
          b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || a.name.localeCompare(b.name)
      );
    const admitted = novel.slice(0, capacity);
    if (admitted.length > 0) {
      await client.query(
        `insert into project_environments
           (project_id, name, first_seen_at, last_seen_at)
         select $1, name, first_seen_at, last_seen_at
           from unnest($2::text[], $3::timestamptz[], $4::timestamptz[])
                as incoming(name, first_seen_at, last_seen_at)
         on conflict (project_id, name) do update
           set first_seen_at = least(project_environments.first_seen_at, excluded.first_seen_at),
               last_seen_at = greatest(project_environments.last_seen_at, excluded.last_seen_at),
               updated_at = clock_timestamp()`,
        [
          projectId,
          admitted.map((item) => item.name),
          admitted.map((item) => item.firstSeenAt),
          admitted.map((item) => item.lastSeenAt)
        ]
      );
    }

    const overflowed = novel.length - admitted.length;
    await client.query(
      `insert into project_environment_registry_state
         (project_id, overflowed, last_overflow_at)
       values ($1, $2, case when $2 then clock_timestamp() else null end)
       on conflict (project_id) do update
         set overflowed = project_environment_registry_state.overflowed or excluded.overflowed,
             last_overflow_at = case
               when excluded.overflowed then clock_timestamp()
               else project_environment_registry_state.last_overflow_at
             end`,
      [projectId, overflowed > 0]
    );

    await client.query("commit");
    return { admitted: admitted.length, overflowed };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listProjectEnvironments(
  pool: Pool,
  projectId: string
): Promise<ProjectEnvironmentRegistry> {
  const [environments, state] = await Promise.all([
    pool.query<EnvironmentRow>(
      `select * from project_environments
        where project_id = $1
        order by hidden asc, last_seen_at desc, name asc`,
      [projectId]
    ),
    pool.query<RegistryStateRow>(
      `select overflowed, last_overflow_at, last_rebuilt_at
         from project_environment_registry_state where project_id = $1`,
      [projectId]
    )
  ]);
  const registryState = state.rows[0];
  return {
    environments: environments.rows.map(fromRow),
    overflowed: registryState?.overflowed ?? false,
    lastOverflowAt: registryState?.last_overflow_at ?? null,
    lastRebuiltAt: registryState?.last_rebuilt_at ?? null
  };
}

export async function setProjectEnvironmentHidden(
  pool: Pool,
  projectId: string,
  environment: string,
  hidden: boolean
): Promise<ProjectEnvironmentRecord | null> {
  const name = normalizeEnvironment(environment);
  if (name === null) return null;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockProject(client, projectId);
    const result = await client.query<EnvironmentRow>(
      `update project_environments
          set hidden = $3
        where project_id = $1 and name = $2
        returning *`,
      [projectId, name, hidden]
    );
    await client.query("commit");
    const row = result.rows[0];
    return row ? fromRow(row) : null;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export interface EnvironmentRegistryRebuildClaim {
  projectId: string;
  startedAt: Date;
  cursor: { timestamp: string; id: string } | null;
  candidates: string[];
}

interface RebuildClaimRow {
  project_id: string;
  rebuild_started_at: Date;
  rebuild_cursor: { timestamp?: unknown; id?: unknown } | null;
  rebuild_candidates: string[];
}

function rebuildClaimFromRow(row: RebuildClaimRow): EnvironmentRegistryRebuildClaim {
  const rawCursor = row.rebuild_cursor;
  const cursor =
    rawCursor && typeof rawCursor.timestamp === "string" && typeof rawCursor.id === "string"
      ? { timestamp: rawCursor.timestamp, id: rawCursor.id }
      : null;
  return {
    projectId: row.project_id,
    startedAt: row.rebuild_started_at,
    cursor,
    candidates: row.rebuild_candidates
  };
}

export async function scheduleEnvironmentRegistryRebuild(
  pool: Pool,
  projectId: string
): Promise<void> {
  await pool.query(
    `insert into project_environment_registry_state (project_id, next_rebuild_at)
     values ($1, now())
     on conflict (project_id) do update set next_rebuild_at = now(), last_error = null`,
    [projectId]
  );
}

export async function claimDueEnvironmentRegistryRebuilds(
  pool: Pool,
  limit: number
): Promise<EnvironmentRegistryRebuildClaim[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<RebuildClaimRow>(
      `with due as (
         select project_id
           from project_environment_registry_state
          where next_rebuild_at <= now()
          order by next_rebuild_at asc, project_id asc
          for update skip locked
          limit $1
       )
       update project_environment_registry_state as state
          set rebuild_started_at = coalesce(
                state.rebuild_started_at,
                date_trunc('milliseconds', clock_timestamp())
              ),
              next_rebuild_at = now() + make_interval(mins => $2),
              last_error = null
         from due
        where state.project_id = due.project_id
       returning state.project_id, state.rebuild_started_at,
                 state.rebuild_cursor, state.rebuild_candidates`,
      [limit, REBUILD_LEASE_MINUTES]
    );
    await client.query("commit");
    return result.rows.map(rebuildClaimFromRow);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function claimEnvironmentRegistryRebuild(
  pool: Pool,
  projectId: string
): Promise<EnvironmentRegistryRebuildClaim | null> {
  const result = await pool.query<RebuildClaimRow>(
    `update project_environment_registry_state
        set rebuild_started_at = coalesce(
              rebuild_started_at,
              date_trunc('milliseconds', clock_timestamp())
            ),
            next_rebuild_at = now() + make_interval(mins => $2),
            last_error = null
      where project_id = $1
      returning project_id, rebuild_started_at, rebuild_cursor, rebuild_candidates`,
    [projectId, REBUILD_LEASE_MINUTES]
  );
  const row = result.rows[0];
  return row ? rebuildClaimFromRow(row) : null;
}

export async function checkpointEnvironmentRegistryRebuild(
  pool: Pool,
  claim: EnvironmentRegistryRebuildClaim,
  cursor: { timestamp: string; id: string },
  candidates: string[]
): Promise<void> {
  const result = await pool.query(
    `update project_environment_registry_state
        set rebuild_cursor = $3::jsonb,
            rebuild_candidates = $4,
            next_rebuild_at = now()
      where project_id = $1 and rebuild_started_at = $2`,
    [claim.projectId, claim.startedAt, JSON.stringify(cursor), candidates]
  );
  if (result.rowCount !== 1) throw new Error("environment registry rebuild claim was lost");
}

export async function failEnvironmentRegistryRebuild(
  pool: Pool,
  claim: EnvironmentRegistryRebuildClaim,
  error: string
): Promise<void> {
  await pool.query(
    `update project_environment_registry_state
        set last_error = left($3, 2000),
            next_rebuild_at = now() + make_interval(mins => $4)
      where project_id = $1 and rebuild_started_at = $2`,
    [claim.projectId, claim.startedAt, error, REBUILD_LEASE_MINUTES]
  );
}

export interface EnvironmentRegistrySnapshotEntry {
  name: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export type EnvironmentRegistrySnapshotLoader = (
  postWatermarkNames: string[]
) => Promise<EnvironmentRegistrySnapshotEntry[]>;

export async function finalizeEnvironmentRegistryRebuild(
  pool: Pool,
  claim: EnvironmentRegistryRebuildClaim,
  loadSnapshot: EnvironmentRegistrySnapshotLoader,
  scanOverflowed: boolean
): Promise<{ count: number; overflowed: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockProject(client, claim.projectId);
    const activeClaim = await client.query(
      `select 1 from project_environment_registry_state
        where project_id = $1 and rebuild_started_at = $2`,
      [claim.projectId, claim.startedAt]
    );
    if (activeClaim.rowCount !== 1) {
      throw new Error("environment registry rebuild claim was lost");
    }
    const currentResult = await client.query<EnvironmentRebuildRow>(
      `select *, updated_at > $2::timestamptz as post_watermark
         from project_environments
        where project_id = $1`,
      [claim.projectId, claim.startedAt]
    );
    const current = currentResult.rows.map(fromRow);
    const currentByName = new Map(current.map((environment) => [environment.name, environment]));
    const postWatermarkNames = new Set(
      currentResult.rows.filter((environment) => environment.post_watermark).map((environment) => environment.name)
    );
    // The loader runs while the project advisory lock is held. It can query
    // ClickHouse for the scanned candidates plus this bounded live-name set,
    // producing exact retained min/max values without a stats-to-swap race.
    // A later ingest blocks on this lock and applies after the transaction.
    const snapshot = await loadSnapshot([...postWatermarkNames]);
    const merged = new Map(
      snapshot.map((environment) => [environment.name, { ...environment }])
    );

    const byRecency = (a: EnvironmentRegistrySnapshotEntry, b: EnvironmentRegistrySnapshotEntry) =>
      b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || a.name.localeCompare(b.name);
    // Live observations after the scan watermark reserve their slots first,
    // even for historical trace timestamps. Otherwise a full older snapshot
    // could erase a just-imported environment merely because its trace time
    // predates the snapshot's selected values.
    const recent = [...merged.values()]
      .filter((environment) => postWatermarkNames.has(environment.name))
      .sort(byRecency);
    const snapshotCandidates = [...merged.values()]
      .filter((environment) => !postWatermarkNames.has(environment.name))
      .sort(byRecency);
    const ordered = [...recent, ...snapshotCandidates];
    const selected = ordered.slice(0, MAX_OBSERVED_ENVIRONMENTS_PER_PROJECT);
    const overflowed = scanOverflowed || ordered.length > selected.length;

    await client.query("delete from project_environments where project_id = $1", [
      claim.projectId
    ]);
    if (selected.length > 0) {
      await client.query(
        `insert into project_environments
           (project_id, name, first_seen_at, last_seen_at, hidden, updated_at)
         select $1, name, first_seen_at, last_seen_at, hidden, now()
           from unnest(
             $2::text[], $3::timestamptz[], $4::timestamptz[], $5::boolean[]
           ) as snapshot(name, first_seen_at, last_seen_at, hidden)`,
        [
          claim.projectId,
          selected.map((environment) => environment.name),
          selected.map((environment) => environment.firstSeenAt),
          selected.map((environment) => environment.lastSeenAt),
          selected.map((environment) => currentByName.get(environment.name)?.hidden ?? false)
        ]
      );
    }

    const state = await client.query<{ overflowed: boolean }>(
      `update project_environment_registry_state
          set overflowed = $3 or coalesce(last_overflow_at > $2, false),
              last_overflow_at = case
                when last_overflow_at > $2 then last_overflow_at
                when $3 then clock_timestamp()
                else null
              end,
              last_rebuilt_at = now(),
              next_rebuild_at = now() + make_interval(hours => $4),
              rebuild_started_at = null,
              rebuild_cursor = null,
              rebuild_candidates = '{}',
              last_error = null
        where project_id = $1 and rebuild_started_at = $2
      returning overflowed`,
      [claim.projectId, claim.startedAt, overflowed, REBUILD_INTERVAL_HOURS]
    );
    if (state.rowCount !== 1) throw new Error("environment registry rebuild claim was lost");
    await client.query("commit");
    return { count: selected.length, overflowed: state.rows[0]!.overflowed };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
