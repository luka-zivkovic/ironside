-- A pull importer can die after raising its fail-closed pending barrier. Keep
-- the exact snapshot in PostgreSQL and fence materialization with a renewable
-- run lease so an independent recovery pass can safely take over.
alter table evaluator_import_trace_state
  add column snapshot jsonb,
  add column run_token text;

alter table evaluator_import_trace_state
  add constraint evaluator_import_trace_state_pending_snapshot_check
    check (not pending or (
      snapshot is not null
      and run_token is not null
      and length(run_token) > 0
      and run_token = btrim(run_token)
    ));

comment on table evaluator_import_trace_state is
  'Durable current snapshot, fenced run generation, and fail-closed pending barrier for pull-imported traces.';

alter table import_checkpoints
  add column run_token text,
  add column lease_expires_at timestamptz;

alter table import_checkpoints
  add constraint import_checkpoints_run_token_check
    check (run_token is null or (
      length(run_token) > 0 and run_token = btrim(run_token)
    ));

-- A receipt becomes terminally acknowledged only after ClickHouse score
-- materialization, not merely after the durable raw object was staged.
alter table evaluator_score_receipts
  add column ingest_materialized_at timestamptz;

alter table evaluator_score_receipts
  add constraint evaluator_score_receipts_materialized_after_staging_check
    check (ingest_materialized_at is null or ingest_staged_at is not null);
