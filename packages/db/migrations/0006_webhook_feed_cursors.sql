-- Webhook rules read the durable trace feed (evaluator_trace_feed) like
-- scheduled exports and OTLP forwards: a run examines only trace versions
-- published after the rule's position. Null means "from the start of the feed".
alter table webhook_rules
  add column feed_cursor_published_at timestamptz,
  add column feed_cursor_trace_id text,
  add column last_run_at timestamptz,
  add column last_run_status text,
  add column last_run_error text,
  add column last_run_delivered_count bigint;

-- Before this migration a run keyed each delivery by the trace's ingest
-- activity time; now it keys it by the trace's feed version. A rule honors
-- deliveries keyed by activity time for feed entries published up to this
-- instant, and for a day after it, while a worker from the previous release
-- may still be delivering. Existing rules get the migration time; a new rule,
-- whichever release's API creates it, gets its creation time.
alter table webhook_rules
  add column scanner_handoff_at timestamptz not null default now();
