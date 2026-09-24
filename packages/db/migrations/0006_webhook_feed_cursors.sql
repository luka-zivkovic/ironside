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

-- Before this migration a delivery was keyed by the trace's ingest activity
-- time; now it is keyed by the trace's feed version. For feed entries
-- published up to this instant, a run first checks for a delivery under the
-- activity time, so upgrading does not send those traces again. Rules created
-- later keep it null and never need the check.
alter table webhook_rules
  add column legacy_delivery_cutoff timestamptz;

update webhook_rules set legacy_delivery_cutoff = now();
