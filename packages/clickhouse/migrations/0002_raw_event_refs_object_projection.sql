-- Terminal ingest recovery resolves one durable object key. The baseline
-- table is trace-first, so large projects otherwise cross a permanent scan
-- cap before recovery can decide whether a snapshot ref is still pending.
alter table raw_event_refs
  modify setting deduplicate_merge_projection_mode = 'rebuild';

alter table raw_event_refs add projection if not exists raw_event_refs_by_object
(
  select project_id, object_key, trace_id, applied
  order by (project_id, object_key, trace_id)
);

alter table raw_event_refs materialize projection raw_event_refs_by_object;
