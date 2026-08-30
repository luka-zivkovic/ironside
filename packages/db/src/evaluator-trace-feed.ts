import type { Observation, Score, Trace } from "@ironside/shared";
import { Buffer } from "node:buffer";
import type { Pool } from "pg";

export interface EvaluatorTraceActivity {
  traceId: string;
  traceVersion: string;
  sourceActivityAt: string;
  publishedAt: string;
}

export interface EvaluatorTraceFeedCursor {
  publishedAt: string;
  traceId: string;
}

export type EvaluatorImportSource = "langfuse" | "langsmith";

export interface EvaluatorImportTraceSnapshot {
  trace: Trace;
  observations: Observation[];
  scores: Score[];
  scoreActivityAt: string;
}

export interface EvaluatorImportTraceState {
  traceId: string;
  activityId: string;
  sourceActivityAt: string;
}

export interface EvaluatorPendingImportSnapshot extends EvaluatorImportTraceState {
  source: EvaluatorImportSource;
  snapshot: EvaluatorImportTraceSnapshot;
}

export interface EvaluatorLegacyPendingImport extends EvaluatorImportTraceState {
  source: EvaluatorImportSource;
}

function encodeEvaluatorImportSnapshot(snapshot: EvaluatorImportTraceSnapshot): string {
  // PostgreSQL jsonb rejects U+0000 even though it is legal inside a JSON
  // string. Store the recovery envelope as base64 JSON inside jsonb so the
  // durable snapshot can preserve the provider payload byte-for-byte without
  // letting one valid payload poison the source checkpoint.
  return Buffer.from(JSON.stringify(snapshot), "utf8").toString("base64");
}

function decodeEvaluatorImportSnapshot(value: unknown): EvaluatorImportTraceSnapshot {
  if (typeof value === "string") {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as EvaluatorImportTraceSnapshot;
  }
  // Compatibility with recovery rows staged by the pre-base64 PR revision.
  return value as EvaluatorImportTraceSnapshot;
}

export async function recordEvaluatorImportRetentionCutoffs(
  pool: Pool,
  entries: Array<{ projectId: string; traceTimestampBefore: string }>
): Promise<void> {
  const unique = [...new Map(entries.map((entry) => [entry.projectId, entry])).values()];
  if (unique.length === 0) return;
  await pool.query(
    `insert into evaluator_import_retention_cutoffs
       (project_id, trace_timestamp_before)
     select item ->> 'projectId',
            (item ->> 'traceTimestampBefore')::timestamptz
       from jsonb_array_elements($1::jsonb) as item
       join projects on projects.id = (item ->> 'projectId')
     on conflict (project_id) do update
       set trace_timestamp_before = greatest(
             evaluator_import_retention_cutoffs.trace_timestamp_before,
             excluded.trace_timestamp_before
           ),
           updated_at = clock_timestamp()`,
    [JSON.stringify(unique)]
  );
}

export async function getEvaluatorImportRetentionCutoff(
  pool: Pool,
  projectId: string
): Promise<string | null> {
  const result = await pool.query<{ trace_timestamp_before: Date }>(
    `select trace_timestamp_before
       from evaluator_import_retention_cutoffs
      where project_id = $1`,
    [projectId]
  );
  return result.rows[0]?.trace_timestamp_before.toISOString() ?? null;
}

/**
 * Marks pull-imported snapshots pending before any ClickHouse write. Exact
 * current-content retries reuse their activity generation; a changed or
 * reverted snapshot receives a strictly newer per-trace generation.
 */
export async function stageEvaluatorImportTraces(
  pool: Pool,
  input: {
    projectId: string;
    source: EvaluatorImportSource;
    runToken: string;
    candidateActivityId: string;
    candidateActivityAt: string;
    traces: {
      traceId: string;
      contentHash: string;
      snapshot: EvaluatorImportTraceSnapshot;
    }[];
  }
): Promise<Map<string, EvaluatorImportTraceState>> {
  const traces = [...new Map(input.traces.map((trace) => [trace.traceId, {
    ...trace,
    snapshot: encodeEvaluatorImportSnapshot(trace.snapshot)
  }])).values()];
  if (traces.length === 0) return new Map();
  const result = await pool.query<{
    trace_id: string;
    activity_id: string;
    source_activity_at: Date;
  }>(
    `with active_run as (
       select 1
         from import_checkpoints
        where project_id = $1 and source = $2 and status = 'running'
          and run_token = $3 and lease_expires_at > clock_timestamp()
     ), input as (
       select item ->> 'traceId' as trace_id,
              item ->> 'contentHash' as content_hash,
              item -> 'snapshot' as snapshot
         from jsonb_array_elements($6::jsonb) as item
     )
     insert into evaluator_import_trace_state
       (project_id, trace_id, source, content_hash, activity_id,
        source_activity_at, snapshot, run_token, pending)
     select $1, trace_id, $2, content_hash, $4,
            date_trunc('milliseconds', $5::timestamptz), snapshot, $3, true
       from input cross join active_run
     on conflict (project_id, trace_id, source) do update
       set content_hash = excluded.content_hash,
           activity_id = case
             when evaluator_import_trace_state.content_hash = excluded.content_hash
               then evaluator_import_trace_state.activity_id
             else excluded.activity_id
           end,
           source_activity_at = case
             when evaluator_import_trace_state.content_hash = excluded.content_hash
               then evaluator_import_trace_state.source_activity_at
             else greatest(
               excluded.source_activity_at,
               evaluator_import_trace_state.source_activity_at + interval '1 millisecond'
             )
           end,
           snapshot = case
             when evaluator_import_trace_state.content_hash = excluded.content_hash
               then evaluator_import_trace_state.snapshot
             else excluded.snapshot
           end,
           run_token = case
             when evaluator_import_trace_state.content_hash = excluded.content_hash
               and not evaluator_import_trace_state.pending
               then evaluator_import_trace_state.run_token
             else excluded.run_token
           end,
           pending = case
             when evaluator_import_trace_state.content_hash = excluded.content_hash
               and not evaluator_import_trace_state.pending
               then false
             else true
           end,
           staged_at = clock_timestamp()
     returning trace_id, activity_id, source_activity_at`,
    [
      input.projectId,
      input.source,
      input.runToken,
      input.candidateActivityId,
      input.candidateActivityAt,
      JSON.stringify(traces)
    ]
  );
  if (result.rows.length !== traces.length) throw new Error("import run lease was lost");
  return new Map(result.rows.map((row) => [row.trace_id, {
    traceId: row.trace_id,
    activityId: row.activity_id,
    sourceActivityAt: row.source_activity_at.toISOString()
  }]));
}

export async function claimPendingEvaluatorImportSnapshots(
  pool: Pool,
  input: {
    projectId: string;
    source: EvaluatorImportSource;
    runToken: string;
  }
): Promise<EvaluatorPendingImportSnapshot[]> {
  const result = await pool.query<{
    active: boolean;
    snapshots: Array<{
      trace_id: string;
      activity_id: string;
      source_activity_at: string;
      snapshot: unknown;
    }> | null;
  }>(
    `with active_run as (
       select 1
         from import_checkpoints
        where project_id = $1 and source = $2 and status = 'running'
          and run_token = $3 and lease_expires_at > clock_timestamp()
     ), claimed as (
       update evaluator_import_trace_state as state
          set run_token = $3, staged_at = clock_timestamp()
         from active_run
        where state.project_id = $1 and state.source = $2 and state.pending
       returning state.trace_id, state.activity_id,
                 to_char(
                   state.source_activity_at at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 ) as source_activity_at,
                 state.snapshot
     )
     select exists(select 1 from active_run) as active,
            coalesce(jsonb_agg(claimed order by trace_id), '[]'::jsonb) as snapshots
       from claimed`,
    [input.projectId, input.source, input.runToken]
  );
  const row = result.rows[0]!;
  if (!row.active) throw new Error("import run lease was lost");
  return (row.snapshots ?? []).map((entry) => ({
    traceId: entry.trace_id,
    activityId: entry.activity_id,
    sourceActivityAt: entry.source_activity_at,
    source: input.source,
    snapshot: decodeEvaluatorImportSnapshot(entry.snapshot)
  }));
}

export async function discardPendingEvaluatorImportSnapshot(
  pool: Pool,
  input: {
    projectId: string;
    source: EvaluatorImportSource;
    traceId: string;
    activityId: string;
    sourceActivityAt: string;
    runToken: string;
  }
): Promise<void> {
  const result = await pool.query(
    `update evaluator_import_trace_state
        set pending = false,
            snapshot = null,
            run_token = null
      where project_id = $1 and source = $2 and trace_id = $3
        and activity_id = $4 and source_activity_at = $5::timestamptz
        and run_token = $6 and pending
        and exists (
          select 1
            from import_checkpoints
           where project_id = $1 and source = $2 and status = 'running'
             and run_token = $6 and lease_expires_at > clock_timestamp()
        )`,
    [
      input.projectId,
      input.source,
      input.traceId,
      input.activityId,
      input.sourceActivityAt,
      input.runToken
    ]
  );
  if (result.rowCount !== 1) throw new Error("stale imported evaluator materialization");
}

export async function listLegacyPendingEvaluatorImports(
  pool: Pool,
  input: { projectId: string; source: EvaluatorImportSource }
): Promise<EvaluatorLegacyPendingImport[]> {
  const result = await pool.query<{
    trace_id: string;
    activity_id: string;
    source_activity_at: Date;
  }>(
    `select trace_id, activity_id, source_activity_at
       from evaluator_import_legacy_pending_recovery
      where project_id = $1 and source = $2
      order by trace_id`,
    [input.projectId, input.source]
  );
  return result.rows.map((row) => ({
    traceId: row.trace_id,
    activityId: row.activity_id,
    sourceActivityAt: row.source_activity_at.toISOString(),
    source: input.source
  }));
}

export async function deleteLegacyPendingEvaluatorImport(
  pool: Pool,
  input: {
    projectId: string;
    source: EvaluatorImportSource;
    traceId: string;
    activityId: string;
    runToken: string;
  }
): Promise<void> {
  const result = await pool.query(
    `delete from evaluator_import_legacy_pending_recovery legacy
      where project_id = $1 and source = $2 and trace_id = $3
        and activity_id = $4
        and exists (
          select 1
            from import_checkpoints
           where project_id = $1 and source = $2 and status = 'running'
             and run_token = $5 and lease_expires_at > clock_timestamp()
        )`,
    [input.projectId, input.source, input.traceId, input.activityId, input.runToken]
  );
  if (result.rowCount !== 1) throw new Error("legacy import recovery lease was lost");
}

export async function listEvaluatorImportRecoveryCandidates(
  pool: Pool,
  limit: number
): Promise<Array<{ projectId: string; source: EvaluatorImportSource }>> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("evaluator import recovery limit must be between 1 and 1000");
  }
  const result = await pool.query<{ project_id: string; source: EvaluatorImportSource }>(
    `select pending.project_id, pending.source
       from (
         select project_id, source
           from evaluator_import_trace_state
          where pending
         union
         select project_id, source
           from evaluator_import_legacy_pending_recovery
       ) pending
       join import_checkpoints checkpoint
         on checkpoint.project_id = pending.project_id
        and checkpoint.source = pending.source
      where (
          checkpoint.status != 'running'
          or checkpoint.lease_expires_at is null
          or checkpoint.lease_expires_at <= clock_timestamp()
        )
      group by pending.project_id, pending.source
      order by pending.project_id, pending.source
      limit $1`,
    [limit]
  );
  return result.rows.map((row) => ({ projectId: row.project_id, source: row.source }));
}

export async function listPendingEvaluatorImportTraceIds(
  pool: Pool,
  projectId: string,
  traceIds: string[]
): Promise<Set<string>> {
  const uniqueTraceIds = [...new Set(traceIds)].filter(Boolean);
  if (uniqueTraceIds.length === 0) return new Set();
  const result = await pool.query<{ trace_id: string }>(
    `select trace_id
       from evaluator_import_trace_state
      where project_id = $1 and trace_id = any($2::text[]) and pending
     union
     select trace_id
       from evaluator_import_legacy_pending_recovery
      where project_id = $1 and trace_id = any($2::text[])`,
    [projectId, uniqueTraceIds]
  );
  return new Set(result.rows.map((row) => row.trace_id));
}

export class EvaluatorScoreIdempotencyConflictError extends Error {
  constructor(readonly scoreId: string) {
    super(`Evaluator score id was already used for a different request: ${scoreId}`);
    this.name = "EvaluatorScoreIdempotencyConflictError";
  }
}

export async function claimEvaluatorScoreReceipt(
  pool: Pool,
  input: {
    projectId: string;
    scoreId: string;
    traceId: string;
    requestFingerprint: string;
    candidateBatchId: string;
  }
): Promise<{ timestamp: string; batchId: string; staged: boolean; materialized: boolean }> {
  const result = await pool.query<{
    trace_id: string;
    request_fingerprint: string;
    score_timestamp: Date;
    ingest_batch_id: string;
    ingest_staged_at: Date | null;
    ingest_materialized_at: Date | null;
  }>(
    `insert into evaluator_score_receipts
       (project_id, score_id, trace_id, request_fingerprint, ingest_batch_id)
     values ($1, $2, $3, $4, $5)
     on conflict (project_id, score_id) do update
       set ingest_batch_id = coalesce(
         evaluator_score_receipts.ingest_batch_id,
         excluded.ingest_batch_id
       )
     returning trace_id, request_fingerprint, score_timestamp,
               ingest_batch_id, ingest_staged_at, ingest_materialized_at`,
    [
      input.projectId,
      input.scoreId,
      input.traceId,
      input.requestFingerprint,
      input.candidateBatchId
    ]
  );
  const receipt = result.rows[0]!;
  if (
    receipt.trace_id !== input.traceId ||
    receipt.request_fingerprint !== input.requestFingerprint
  ) {
    throw new EvaluatorScoreIdempotencyConflictError(input.scoreId);
  }
  return {
    timestamp: receipt.score_timestamp.toISOString(),
    batchId: receipt.ingest_batch_id,
    staged: receipt.ingest_staged_at !== null,
    materialized: receipt.ingest_materialized_at !== null
  };
}

export async function markEvaluatorScoreReceiptMaterialized(
  pool: Pool,
  input: { projectId: string; batchId: string }
): Promise<boolean> {
  const result = await pool.query(
    `update evaluator_score_receipts
        set ingest_materialized_at = coalesce(
          ingest_materialized_at,
          clock_timestamp()
        )
      where project_id = $1 and ingest_batch_id = $2
        and ingest_staged_at is not null`,
    [input.projectId, input.batchId]
  );
  return result.rowCount === 1;
}

export async function hasUnmaterializedEvaluatorScoreReceiptBatch(
  pool: Pool,
  input: { projectId: string; batchId: string }
): Promise<boolean> {
  const result = await pool.query(
    `select 1
       from evaluator_score_receipts
      where project_id = $1 and ingest_batch_id = $2
        and ingest_staged_at is not null
        and ingest_materialized_at is null`,
    [input.projectId, input.batchId]
  );
  return result.rowCount === 1;
}

export async function markEvaluatorScoreReceiptStaged(
  pool: Pool,
  input: { projectId: string; scoreId: string; batchId: string }
): Promise<void> {
  const result = await pool.query(
    `update evaluator_score_receipts
        set ingest_staged_at = coalesce(ingest_staged_at, clock_timestamp())
      where project_id = $1 and score_id = $2 and ingest_batch_id = $3
      returning 1`,
    [input.projectId, input.scoreId, input.batchId]
  );
  if (result.rowCount !== 1) {
    throw new Error(`evaluator score receipt disappeared before staging: ${input.scoreId}`);
  }
}

/**
 * Records the newest trace/observation activity only after ClickHouse and the
 * raw-event index are fully materialized. Replaying the same ingest batch is
 * a no-op and does not move published_at; a genuinely newer activity version
 * moves the row forward so every independent consumer sees it again.
 */
export async function publishEvaluatorTraceActivities(
  pool: Pool,
  input: {
    projectId: string;
    traceIds: string[];
    sourceActivityAt: string;
    activityId: string;
    importSource?: EvaluatorImportSource;
    importRunToken?: string;
    importTraceTimestamp?: string;
  }
): Promise<void> {
  const traceIds = [...new Set(input.traceIds)].filter((traceId) => traceId.length > 0);
  if (traceIds.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("begin");
    // A timestamp or sequence allocated before commit can be overtaken by a
    // concurrent transaction. Serialize publications per project so cursor
    // order is also commit order without coupling unrelated tenants.
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1::text, 72819463))",
      [input.projectId]
    );
    if (input.importSource) {
      if (!input.importRunToken) {
        throw new Error("imported evaluator publication requires a run token");
      }
      if (!input.importTraceTimestamp) {
        throw new Error("imported evaluator publication requires a trace timestamp");
      }
      if (traceIds.length !== 1) {
        throw new Error("imported evaluator publication requires exactly one trace");
      }
      const claimed = await client.query(
        `update evaluator_import_trace_state
            set pending = false,
                snapshot = null,
                run_token = null
          where project_id = $1 and trace_id = $2 and source = $3
            and activity_id = $4
            and source_activity_at = $5::timestamptz
            and run_token = $6
            and pending
            and not exists (
              select 1
                from evaluator_import_retention_cutoffs cutoff
               where cutoff.project_id = $1
                 and cutoff.trace_timestamp_before > $7::timestamptz
            )
            and exists (
              select 1
                from import_checkpoints
               where project_id = $1 and source = $3 and status = 'running'
                 and run_token = $6 and lease_expires_at > clock_timestamp()
            )
          returning 1`,
        [
          input.projectId,
          traceIds[0],
          input.importSource,
          input.activityId,
          input.sourceActivityAt,
          input.importRunToken,
          input.importTraceTimestamp
        ]
      );
      if (claimed.rowCount !== 1) {
        throw new Error("stale imported evaluator materialization");
      }
    }
    const inserted = await client.query<{ trace_id: string }>(
      `insert into evaluator_trace_feed_activities
         (project_id, trace_id, activity_id)
       select $1, trace_id, $3
       from unnest($2::text[]) as trace_id
       on conflict (project_id, trace_id, activity_id) do nothing
       returning trace_id`,
      [input.projectId, traceIds, input.activityId]
    );
    const newlyPublishedTraceIds = inserted.rows.map((row) => row.trace_id);
    if (newlyPublishedTraceIds.length > 0) {
      const watermark = await client.query<{ published_at: string }>(
        `insert into evaluator_trace_feed_watermarks (project_id, published_at)
         values ($1, clock_timestamp())
         on conflict (project_id) do update
           set published_at = greatest(
             excluded.published_at,
             evaluator_trace_feed_watermarks.published_at + interval '1 microsecond'
           )
         returning to_char(
           published_at at time zone 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) as published_at`,
        [input.projectId]
      );
      await client.query(
        `insert into evaluator_trace_feed
           (project_id, trace_id, trace_version, source_activity_at, published_at)
         select $1, trace_id, $4::timestamptz, $3::timestamptz,
                $4::timestamptz
         from unnest($2::text[]) as trace_id
         on conflict (project_id, trace_id) do update
           set trace_version = excluded.trace_version,
               source_activity_at = greatest(
                 evaluator_trace_feed.source_activity_at,
                 excluded.source_activity_at
               ),
               published_at = excluded.published_at`,
        [
          input.projectId,
          newlyPublishedTraceIds,
          input.sourceActivityAt,
          watermark.rows[0]!.published_at
        ]
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listEvaluatorTraceActivities(
  pool: Pool,
  input: {
    projectId: string;
    cursor?: EvaluatorTraceFeedCursor | undefined;
    limit: number;
  }
): Promise<EvaluatorTraceActivity[]> {
  const result = await pool.query<{
    trace_id: string;
    trace_version: string;
    source_activity_at: Date;
    published_at: string;
  }>(
    `select trace_id,
            to_char(trace_version at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as trace_version,
            source_activity_at,
            to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as published_at
       from evaluator_trace_feed
      where project_id = $1
        and (
          $2::timestamptz is null
          or (published_at, trace_id) > ($2::timestamptz, $3::text)
        )
      order by published_at asc, trace_id asc
      limit $4`,
    [input.projectId, input.cursor?.publishedAt ?? null, input.cursor?.traceId ?? "", input.limit]
  );
  return result.rows.map((row) => ({
    traceId: row.trace_id,
    traceVersion: row.trace_version,
    sourceActivityAt: row.source_activity_at.toISOString(),
    publishedAt: row.published_at
  }));
}

export interface EvaluatorTracePublication {
  traceId: string;
  traceVersion: string;
  sourceActivityAt: string;
}

export async function getEvaluatorTracePublications(
  pool: Pool,
  projectId: string,
  traceIds: string[]
): Promise<Map<string, EvaluatorTracePublication>> {
  const uniqueTraceIds = [...new Set(traceIds)].filter(Boolean);
  if (uniqueTraceIds.length === 0) return new Map();
  const result = await pool.query<{
    trace_id: string;
    trace_version: string;
    source_activity_at: Date;
  }>(
    `select trace_id,
            to_char(trace_version at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as trace_version,
            source_activity_at
       from evaluator_trace_feed
      where project_id = $1 and trace_id = any($2::text[])`,
    [projectId, uniqueTraceIds]
  );
  return new Map(result.rows.map((row) => [row.trace_id, {
    traceId: row.trace_id,
    traceVersion: row.trace_version,
    sourceActivityAt: row.source_activity_at.toISOString()
  }]));
}

export async function listEvaluatorPublishedTraceIdsForActivity(
  pool: Pool,
  input: { projectId: string; activityId: string }
): Promise<string[]> {
  const result = await pool.query<{ trace_id: string }>(
    `select trace_id
       from evaluator_trace_feed_activities
      where project_id = $1 and activity_id = $2
      order by trace_id asc`,
    [input.projectId, input.activityId]
  );
  return result.rows.map((row) => row.trace_id);
}

export async function deleteEvaluatorTraceFeedEntries(
  pool: Pool,
  entries: { projectId: string; traceId: string; traceVersion: string }[]
): Promise<number> {
  if (entries.length === 0) return 0;
  const projectIds = entries.map((entry) => entry.projectId);
  const traceIds = entries.map((entry) => entry.traceId);
  const traceVersions = entries.map((entry) => entry.traceVersion);
  const result = await pool.query<{ deleted_count: string }>(
    `with targets as (
       select * from unnest($1::text[], $2::text[], $3::text[])
         as target(project_id, trace_id, trace_version)
     ), deleted_feed as (
       delete from evaluator_trace_feed feed
       using targets
       where feed.project_id = targets.project_id
         and feed.trace_id = targets.trace_id
         and feed.trace_version = targets.trace_version::timestamptz
       returning feed.project_id, feed.trace_id
     ), deleted_activities as (
       delete from evaluator_trace_feed_activities activity
       using deleted_feed
       where activity.project_id = deleted_feed.project_id
         and activity.trace_id = deleted_feed.trace_id
       returning 1
     )
     select count(*)::text as deleted_count from deleted_feed`,
    [projectIds, traceIds, traceVersions]
  );
  return Number(result.rows[0]?.deleted_count ?? 0);
}

export async function listEvaluatorTraceFeedKeys(
  pool: Pool,
  input: { after?: { projectId: string; traceId: string }; limit: number }
): Promise<{ projectId: string; traceId: string; traceVersion: string }[]> {
  const result = await pool.query<{
    project_id: string;
    trace_id: string;
    trace_version: string;
  }>(
    `select project_id, trace_id,
            to_char(trace_version at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as trace_version
       from evaluator_trace_feed
      where $1::text is null or (project_id, trace_id) > ($1::text, $2::text)
      order by project_id asc, trace_id asc
      limit $3`,
    [input.after?.projectId ?? null, input.after?.traceId ?? "", input.limit]
  );
  return result.rows.map((row) => ({
    projectId: row.project_id,
    traceId: row.trace_id,
    traceVersion: row.trace_version
  }));
}
