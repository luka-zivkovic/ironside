-- Pull providers expose inclusive historical boundaries. Once Ironside has
-- enforced retention, keep a durable monotonic cutoff so a later source poll
-- cannot recreate an expired trace from the upstream system.
create table evaluator_import_retention_cutoffs (
  project_id text primary key references projects(id) on delete cascade,
  trace_timestamp_before timestamptz not null,
  updated_at timestamptz not null default clock_timestamp()
);

comment on table evaluator_import_retention_cutoffs is
  'Monotonic trace timestamp cutoff preventing pull imports from resurrecting retention-expired data.';
