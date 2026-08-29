-- Durable latest-activity index for pull-based evaluator integrations.
--
-- ClickHouse remains the trace store. This small Postgres table records when
-- the ingest worker has finished materializing the latest trace/observation
-- activity so a cursor cannot skip a batch that was accepted before an
-- outage but became queryable only after recovery.

create table evaluator_trace_feed (
  project_id text not null references projects(id) on delete cascade,
  trace_id text not null,
  trace_version timestamptz not null,
  published_at timestamptz not null default clock_timestamp(),
  primary key (project_id, trace_id),
  constraint evaluator_trace_feed_trace_id_check
    check (length(trace_id) > 0 and trace_id = btrim(trace_id))
);

create index evaluator_trace_feed_project_cursor_idx
  on evaluator_trace_feed (project_id, published_at, trace_id);

comment on table evaluator_trace_feed is
  'Latest successfully materialized trace/observation activity per project trace for evaluator-feed cursors. Scores never update this table.';
