-- Full-snapshot pull reconciliation may remove feedback that disappeared from
-- the provider, but must never tombstone local/native/Coeval assessments for
-- the same trace. Persist explicit storage ownership for imported scores.
alter table scores
  add column if not exists import_source LowCardinality(Nullable(String)) after source;
