-- Durable latest-activity index for pull-based evaluator integrations.
--
-- ClickHouse remains the trace store. This small Postgres table records when
-- the ingest worker has finished materializing the latest trace/observation
-- activity so a cursor cannot skip a batch that was accepted before an
-- outage but became queryable only after recovery.

create table evaluator_trace_feed (
  project_id text not null references projects(id) on delete cascade,
  trace_id text not null,
  -- Public snapshot identity. This is the commit-ordered publication clock,
  -- not the source activity clock, so even a late older batch creates a new
  -- immutable evaluator version.
  trace_version timestamptz not null,
  -- Latest API receipt time materialized into the current snapshot. Settlement
  -- remains source-activity based even though snapshot identity is publication
  -- based.
  source_activity_at timestamptz not null,
  published_at timestamptz not null default clock_timestamp(),
  primary key (project_id, trace_id),
  constraint evaluator_trace_feed_trace_id_check
    check (length(trace_id) > 0 and trace_id = btrim(trace_id))
);

create index evaluator_trace_feed_project_cursor_idx
  on evaluator_trace_feed (project_id, published_at, trace_id);

-- A project-scoped high-water mark survives trace retention. It prevents a
-- later publication from falling behind an already-issued consumer cursor if
-- host time moves backwards or two commits observe the same clock tick.
create table evaluator_trace_feed_watermarks (
  project_id text primary key references projects(id) on delete cascade,
  published_at timestamptz not null
);

-- The score table's physical identity includes the UTC date of timestamp.
-- Keep the first accepted timestamp and request fingerprint in Postgres so a
-- lost-response retry on another day still converges on one ClickHouse row.
create table evaluator_score_receipts (
  project_id text not null references projects(id) on delete cascade,
  score_id text not null,
  trace_id text not null,
  request_fingerprint text not null,
  score_timestamp timestamptz not null default clock_timestamp(),
  primary key (project_id, score_id),
  constraint evaluator_score_receipts_score_id_check
    check (length(score_id) > 0 and score_id = btrim(score_id)),
  constraint evaluator_score_receipts_trace_id_check
    check (length(trace_id) > 0 and trace_id = btrim(trace_id)),
  constraint evaluator_score_receipts_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$')
);

create index evaluator_score_receipts_trace_idx
  on evaluator_score_receipts (project_id, trace_id);

-- Publishing must be retry-safe even when a batch succeeds through Postgres
-- and then retries because final object-storage cleanup failed. One durable row
-- per materialized batch/trace prevents that retry from minting another
-- snapshot version. Retention reconciliation removes these rows together with
-- their trace feed row.
create table evaluator_trace_feed_activities (
  project_id text not null references projects(id) on delete cascade,
  trace_id text not null,
  activity_id text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (project_id, trace_id, activity_id),
  constraint evaluator_trace_feed_activities_trace_id_check
    check (length(trace_id) > 0 and trace_id = btrim(trace_id)),
  constraint evaluator_trace_feed_activities_activity_id_check
    check (length(activity_id) > 0 and activity_id = btrim(activity_id))
);

comment on table evaluator_trace_feed is
  'Latest successfully materialized trace/observation activity per project trace for evaluator-feed cursors. Scores never update this table.';

comment on table evaluator_trace_feed_activities is
  'Idempotency ledger for materialized ingest batches published into the evaluator trace feed.';

comment on table evaluator_trace_feed_watermarks is
  'Durable per-project publication high-water marks for commit-ordered evaluator cursors.';

comment on table evaluator_score_receipts is
  'First-write timestamp and request identity for retry-idempotent native evaluator scores.';
