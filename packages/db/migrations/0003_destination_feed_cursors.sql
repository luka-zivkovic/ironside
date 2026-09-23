-- Position of each scheduled export and OTLP forward rule in the durable,
-- commit-ordered trace feed (evaluator_trace_feed). A run sends only settled
-- trace versions published after this position, then advances it once the
-- destination accepted them. Null means "from the start of the feed".
alter table export_configs
  add column feed_cursor_published_at timestamptz,
  add column feed_cursor_trace_id text;

alter table otlp_forward_rules
  add column feed_cursor_published_at timestamptz,
  add column feed_cursor_trace_id text;
