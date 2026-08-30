-- Pull importers do not have raw-object refs, but their ClickHouse trace and
-- observation writes still need the same fail-closed materialization barrier.
-- Current content identity gives unchanged inclusive-boundary reimports a
-- stable CH activity timestamp, while an A→B→A reversion allocates a fresh
-- generation because the current hash changed from B.

create table evaluator_import_trace_state (
  project_id text not null references projects(id) on delete cascade,
  trace_id text not null,
  source text not null,
  content_hash text not null,
  activity_id text not null,
  source_activity_at timestamptz not null,
  pending boolean not null default true,
  staged_at timestamptz not null default clock_timestamp(),
  primary key (project_id, trace_id, source),
  constraint evaluator_import_trace_state_source_check
    check (source in ('langfuse', 'langsmith')),
  constraint evaluator_import_trace_state_content_hash_check
    check (content_hash ~ '^[0-9a-f]{64}$')
);

create index evaluator_import_trace_state_pending_idx
  on evaluator_import_trace_state (project_id, trace_id)
  where pending;

-- Terminal recovery looks up every trace published by one ingest activity.
-- The original primary key is trace-first, so add the inverse access path.
create index evaluator_trace_feed_activities_project_activity_idx
  on evaluator_trace_feed_activities (project_id, activity_id);

comment on table evaluator_import_trace_state is
  'Current content generation and fail-closed pending barrier for pull-imported trace snapshots.';

-- Exact score retries must not recreate a retention-deleted ClickHouse row.
-- The durable ingest batch id makes a pre-staging crash resumable, while the
-- staged marker proves the raw object + pending recovery intent already exist.
alter table evaluator_score_receipts
  add column ingest_batch_id text,
  add column ingest_staged_at timestamptz;

alter table evaluator_score_receipts
  add constraint evaluator_score_receipts_ingest_batch_id_check
    check (ingest_batch_id is null or (
      length(ingest_batch_id) > 0 and ingest_batch_id = btrim(ingest_batch_id)
    ));
