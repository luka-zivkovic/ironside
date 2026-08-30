-- Provider feedback belongs to the durable pull snapshot so score-only
-- changes are materialized, but annotations must not reopen evaluator traces.
-- Track evaluator-visible identity separately from full import identity.
alter table evaluator_import_trace_state
  add column evaluator_content_hash text,
  add column publish_required boolean not null default true;

update evaluator_import_trace_state
   set evaluator_content_hash = content_hash;

alter table evaluator_import_trace_state
  alter column evaluator_content_hash set not null,
  add constraint evaluator_import_trace_state_evaluator_content_hash_check
    check (evaluator_content_hash ~ '^[0-9a-f]{64}$');
