-- 0003 could leave a pull-import barrier pending without a recoverable full
-- snapshot. Move only those legacy rows into an explicit handoff ledger before
-- 0004 validates the new snapshot+lease invariant. The evaluator keeps them
-- blocked until the new worker tombstones possible partial CH rows and lets the
-- provider import allocate a fresh generation.
create table evaluator_import_legacy_pending_recovery (
  project_id text not null references projects(id) on delete cascade,
  trace_id text not null,
  source text not null,
  activity_id text not null,
  source_activity_at timestamptz not null,
  staged_at timestamptz not null,
  primary key (project_id, trace_id, source),
  constraint evaluator_import_legacy_pending_recovery_source_check
    check (source in ('langfuse', 'langsmith'))
);

do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = current_schema()
       and table_name = 'evaluator_import_trace_state'
       and column_name = 'snapshot'
  ) then
    execute $handoff$
      insert into evaluator_import_legacy_pending_recovery
        (project_id, trace_id, source, activity_id, source_activity_at, staged_at)
      select project_id, trace_id, source, activity_id, source_activity_at, staged_at
        from evaluator_import_trace_state
       where pending and snapshot is null and run_token is null
      on conflict (project_id, trace_id, source) do nothing
    $handoff$;
    execute $clear$
      delete from evaluator_import_trace_state
       where pending and snapshot is null and run_token is null
    $clear$;
  else
    insert into evaluator_import_legacy_pending_recovery
      (project_id, trace_id, source, activity_id, source_activity_at, staged_at)
    select project_id, trace_id, source, activity_id, source_activity_at, staged_at
      from evaluator_import_trace_state
     where pending
    on conflict (project_id, trace_id, source) do nothing;
    delete from evaluator_import_trace_state where pending;
  end if;
end $$;

comment on table evaluator_import_legacy_pending_recovery is
  'Pre-lease pending pull imports requiring fail-closed CH cleanup before source replay.';
