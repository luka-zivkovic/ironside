-- Traces whose scores changed in a batch with no trace or observation
-- activity. evaluator_trace_feed deliberately does not move for scores (a
-- score must never reopen a trace for evaluators), so scheduled exports read
-- this feed to send scores that arrive after their trace was exported.
create table trace_score_feed (
  project_id text not null references projects(id) on delete cascade,
  trace_id text not null,
  published_at timestamptz not null,
  primary key (project_id, trace_id),
  constraint trace_score_feed_trace_id_check
    check (length(trace_id) > 0 and trace_id = btrim(trace_id))
);

create index trace_score_feed_project_cursor_idx
  on trace_score_feed (project_id, published_at, trace_id);

alter table export_configs
  add column score_cursor_published_at timestamptz,
  add column score_cursor_trace_id text;

alter table otlp_forward_rules
  add column last_run_at timestamptz,
  add column last_run_status text,
  add column last_run_error text,
  add column last_run_forwarded_count bigint;
