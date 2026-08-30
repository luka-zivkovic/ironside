-- Durable whole-trace tombstones let later retention passes remove child rows
-- that arrive after the parent trace itself has already been retained away.
create table if not exists evaluator_trace_retention
(
    project_id LowCardinality(String),
    trace_id   String,
    expired_at DateTime64(6)
)
engine = ReplacingMergeTree(expired_at)
order by (project_id, trace_id);
