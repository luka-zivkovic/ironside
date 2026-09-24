-- When each field of a LangFuse-compatible trace or observation was last
-- sent: field name -> receive time of the batch that sent it. The worker
-- merges partial create/update events by recency with it, whatever order it
-- processes their batches in, and tells real values from placeholders it
-- filled in (spec/langfuse-compat-v1.md). Holds no payloads.
create table langfuse_field_provenance (
  project_id text not null references projects(id) on delete cascade,
  entity_kind text not null check (entity_kind in ('trace', 'observation')),
  entity_id text not null,
  sent_at jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (project_id, entity_kind, entity_id)
);

create index langfuse_field_provenance_updated_idx on langfuse_field_provenance (updated_at);
