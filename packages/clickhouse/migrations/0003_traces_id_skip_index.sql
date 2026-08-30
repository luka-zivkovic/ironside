-- Full-snapshot pull reconciliation looks up the current trace by
-- (project_id,id), while the base table orders by project/day/id. Bound that
-- lookup independently of total project cardinality.
alter table traces
  add index if not exists idx_trace_id id type bloom_filter(0.01) granularity 1;

alter table traces materialize index idx_trace_id;
