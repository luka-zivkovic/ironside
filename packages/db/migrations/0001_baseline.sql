create table organizations (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table projects (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  name text not null,
  rate_limit_per_minute integer,
  retention_days integer,
  trace_quiet_period_seconds integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_rate_limit_per_minute_positive
    check (rate_limit_per_minute is null or rate_limit_per_minute > 0),
  constraint projects_retention_days_positive
    check (retention_days is null or retention_days > 0),
  constraint projects_trace_quiet_period_seconds_positive
    check (trace_quiet_period_seconds is null or trace_quiet_period_seconds > 0)
);

create index projects_organization_id_idx on projects(organization_id);

create table import_checkpoints (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  source text not null,
  checkpoint jsonb not null default '{}'::jsonb,
  status text not null default 'idle',
  run_token text,
  lease_expires_at timestamptz,
  last_error text,
  imported_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique (project_id, source),
  constraint import_checkpoints_run_token_check
    check (run_token is null or (
      length(run_token) > 0 and run_token = btrim(run_token)
    ))
);

create index import_checkpoints_project_id_idx on import_checkpoints(project_id);

create table export_configs (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  name text not null,
  format text not null default 'jsonl',
  filter jsonb not null default '{}'::jsonb,
  destination_bucket text not null,
  destination_prefix text not null default '',
  destination_endpoint text not null,
  destination_region text not null default 'us-east-1',
  destination_access_key_id text not null,
  destination_secret_access_key_encrypted text not null,
  enabled boolean not null default true,
  poll_interval_seconds integer not null default 3600,
  next_run_at timestamptz not null default now(),
  last_run_at timestamptz,
  last_run_status text,
  last_run_error text,
  last_run_row_count bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint export_configs_poll_interval_positive check (poll_interval_seconds > 0)
);

create index export_configs_project_id_idx on export_configs(project_id);
create index export_configs_due_idx on export_configs(next_run_at) where enabled = true;

create table otlp_forward_rules (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  name text not null,
  destination_url text not null,
  destination_auth_header_encrypted text,
  filter jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  poll_interval_seconds integer not null default 300,
  next_run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint otlp_forward_rules_poll_interval_positive check (poll_interval_seconds > 0)
);

create index otlp_forward_rules_project_id_idx on otlp_forward_rules(project_id);
create index otlp_forward_rules_due_idx on otlp_forward_rules(next_run_at) where enabled = true;

create table webhook_rules (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  name text not null,
  destination_url text not null,
  signing_secret_encrypted text not null,
  filter jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  poll_interval_seconds integer not null default 60,
  next_run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint webhook_rules_poll_interval_positive check (poll_interval_seconds > 0)
);

create index webhook_rules_project_id_idx on webhook_rules(project_id);
create index webhook_rules_due_idx on webhook_rules(next_run_at) where enabled = true;

create table webhook_deliveries (
  id text primary key,
  webhook_rule_id text not null references webhook_rules(id) on delete cascade,
  trace_id text not null,
  trace_version timestamptz not null,
  status text not null default 'pending',
  last_error text,
  attempted_at timestamptz not null default now(),
  delivered_at timestamptz,
  constraint webhook_deliveries_rule_trace_version_key
    unique (webhook_rule_id, trace_id, trace_version)
);

create index webhook_deliveries_rule_id_idx on webhook_deliveries(webhook_rule_id);

create table import_sources (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  provider text not null,
  encrypted_credentials text not null,
  enabled boolean not null default true,
  poll_interval_seconds integer not null default 3600,
  next_run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, provider),
  constraint import_sources_poll_interval_positive check (poll_interval_seconds > 0)
);

create index import_sources_project_id_idx on import_sources(project_id);
create index import_sources_due_idx on import_sources(next_run_at) where enabled = true;

create table ingest_event_failures (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  batch_id text not null,
  object_key text not null,
  event_id text not null,
  source text not null,
  event_type text not null,
  error text not null,
  created_at timestamptz not null default now()
);

create index ingest_event_failures_project_created_idx
  on ingest_event_failures(project_id, created_at desc);
create index ingest_event_failures_created_idx on ingest_event_failures(created_at);
create index ingest_event_failures_project_object_idx
  on ingest_event_failures(project_id, object_key, created_at desc, id);

create table media_assets (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  sha256 text not null,
  content_type text not null,
  size_bytes bigint not null,
  object_key text not null,
  created_at timestamptz not null default now(),
  unique (project_id, sha256)
);

create index media_assets_project_created_idx
  on media_assets(project_id, created_at desc);

create table raw_retention_intents (
  id text primary key,
  preparation_id text not null,
  project_id text not null,
  ingest_batch_id text not null,
  object_key text not null,
  object_size_bytes bigint not null check (object_size_bytes between 0 and 1073741824),
  retention_cutoff_day date not null,
  effective_retention_days integer not null check (effective_retention_days > 0),
  trace_ids jsonb not null check (
    jsonb_typeof(trace_ids) = 'array'
    and jsonb_array_length(trace_ids) <= 10000
    and octet_length(trace_ids::text) <= 1048576
  ),
  classification text not null check (classification in ('applied', 'terminal_failed')),
  diagnostic_count integer not null default 0 check (diagnostic_count >= 0),
  state text not null default 'prepared' check (state in ('prepared', 'executing', 'complete')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or char_length(last_error) <= 2000),
  prepared_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (project_id, object_key)
);

create index raw_retention_intents_prepared_idx
  on raw_retention_intents(project_id, prepared_at, id)
  where state = 'prepared';

create table owner_principals (
  id text primary key,
  organization_id text not null unique references organizations(id) on delete restrict,
  username text not null,
  username_normalized text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint owner_principals_username_not_blank check (length(trim(username)) > 0)
);

create unique index owner_principals_singleton_idx on owner_principals ((1));

create table owner_auth_challenges (
  id text primary key,
  purpose text not null check (purpose in ('setup', 'recovery')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint owner_auth_challenges_token_hash_shape check (token_hash ~ '^[0-9a-f]{64}$')
);

create index owner_auth_challenges_active_idx
  on owner_auth_challenges(purpose, expires_at) where consumed_at is null;

create table owner_sessions (
  id text primary key,
  principal_id text not null references owner_principals(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint owner_sessions_token_hash_shape check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint owner_sessions_expiry_order check (idle_expires_at <= absolute_expires_at)
);

create index owner_sessions_principal_idx
  on owner_sessions(principal_id, created_at desc);
create index owner_sessions_active_idx
  on owner_sessions(token_hash, idle_expires_at, absolute_expires_at)
  where revoked_at is null;

create table auth_audit_events (
  id text primary key,
  event_type text not null,
  principal_id text references owner_principals(id) on delete set null,
  organization_id text references organizations(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index auth_audit_events_created_at_idx on auth_audit_events(created_at desc);

create table machine_credentials (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,
  preset text not null check (preset in ('ingest', 'integration')),
  capabilities text[] not null,
  expires_at timestamptz,
  created_by_principal_id text references owner_principals(id) on delete set null,
  created_by_username text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by_principal_id text references owner_principals(id) on delete set null,
  revoked_by_username text,
  constraint machine_credentials_name_not_blank check (length(trim(name)) > 0),
  constraint machine_credentials_expiry_order check (expires_at is null or expires_at > created_at),
  constraint machine_credentials_capabilities_valid check (
    cardinality(capabilities) > 0
    and array_position(capabilities, null) is null
    and capabilities <@ array['ingest', 'media:write', 'traces:read', 'scores:write']::text[]
  ),
  constraint machine_credentials_revocation_actor check (
    (revoked_at is null and revoked_by_principal_id is null and revoked_by_username is null)
    or (revoked_at is not null and revoked_by_username is not null)
  )
);

create index machine_credentials_project_created_idx
  on machine_credentials(project_id, created_at desc);
create index machine_credentials_active_hash_idx
  on machine_credentials(token_hash) where revoked_at is null;

create table project_environments (
  project_id text not null references projects(id) on delete cascade,
  name text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  hidden boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (project_id, name),
  constraint project_environments_name_valid check (
    char_length(name) between 1 and 64 and name = btrim(name)
  ),
  constraint project_environments_seen_order check (first_seen_at <= last_seen_at)
);

create index project_environments_project_visible_idx
  on project_environments(project_id, hidden, last_seen_at desc, name);

create table project_environment_registry_state (
  project_id text primary key references projects(id) on delete cascade,
  overflowed boolean not null default false,
  last_overflow_at timestamptz,
  last_rebuilt_at timestamptz,
  next_rebuild_at timestamptz not null default now(),
  rebuild_started_at timestamptz,
  rebuild_cursor jsonb,
  rebuild_candidates text[] not null default '{}',
  last_error text
);

create index project_environment_registry_due_idx
  on project_environment_registry_state(next_rebuild_at);

-- Durable publication state for the native evaluator integration. ClickHouse
-- remains the trace store; PostgreSQL supplies commit-ordered cursors,
-- idempotency, and crash-recoverable materialization barriers.
create table evaluator_trace_feed (
  project_id text not null references projects(id) on delete cascade,
  trace_id text not null,
  trace_version timestamptz not null,
  source_activity_at timestamptz not null,
  published_at timestamptz not null default clock_timestamp(),
  primary key (project_id, trace_id),
  constraint evaluator_trace_feed_trace_id_check
    check (length(trace_id) > 0 and trace_id = btrim(trace_id))
);

create index evaluator_trace_feed_project_cursor_idx
  on evaluator_trace_feed (project_id, published_at, trace_id);

create table evaluator_trace_feed_watermarks (
  project_id text primary key references projects(id) on delete cascade,
  published_at timestamptz not null
);

create table evaluator_score_receipts (
  project_id text not null references projects(id) on delete cascade,
  score_id text not null,
  trace_id text not null,
  request_fingerprint text not null,
  score_timestamp timestamptz not null default clock_timestamp(),
  ingest_batch_id text,
  ingest_staged_at timestamptz,
  ingest_materialized_at timestamptz,
  primary key (project_id, score_id),
  constraint evaluator_score_receipts_score_id_check
    check (length(score_id) > 0 and score_id = btrim(score_id)),
  constraint evaluator_score_receipts_trace_id_check
    check (length(trace_id) > 0 and trace_id = btrim(trace_id)),
  constraint evaluator_score_receipts_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint evaluator_score_receipts_ingest_batch_id_check
    check (ingest_batch_id is null or (
      length(ingest_batch_id) > 0 and ingest_batch_id = btrim(ingest_batch_id)
    )),
  constraint evaluator_score_receipts_materialized_after_staging_check
    check (ingest_materialized_at is null or ingest_staged_at is not null)
);

create index evaluator_score_receipts_trace_idx
  on evaluator_score_receipts (project_id, trace_id);

create table evaluator_trace_feed_activities (
  project_id text not null references projects(id) on delete cascade,
  trace_id text not null,
  activity_id text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (project_id, trace_id, activity_id),
  constraint evaluator_trace_feed_activities_trace_id_check
    check (length(trace_id) > 0 and trace_id = btrim(trace_id)),
  constraint evaluator_trace_feed_activities_activity_id_check
    check (length(activity_id) > 0 and activity_id = btrim(activity_id))
);

create index evaluator_trace_feed_activities_project_activity_idx
  on evaluator_trace_feed_activities (project_id, activity_id);

create table evaluator_import_trace_state (
  project_id text not null references projects(id) on delete cascade,
  trace_id text not null,
  source text not null,
  content_hash text not null,
  evaluator_content_hash text not null,
  activity_id text not null,
  source_activity_at timestamptz not null,
  pending boolean not null default true,
  publish_required boolean not null default true,
  staged_at timestamptz not null default clock_timestamp(),
  snapshot jsonb,
  run_token text,
  primary key (project_id, trace_id, source),
  constraint evaluator_import_trace_state_source_check
    check (source in ('langfuse', 'langsmith')),
  constraint evaluator_import_trace_state_content_hash_check
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint evaluator_import_trace_state_evaluator_content_hash_check
    check (evaluator_content_hash ~ '^[0-9a-f]{64}$'),
  constraint evaluator_import_trace_state_pending_snapshot_check
    check (not pending or (
      snapshot is not null
      and run_token is not null
      and length(run_token) > 0
      and run_token = btrim(run_token)
    ))
);

create index evaluator_import_trace_state_pending_idx
  on evaluator_import_trace_state (project_id, trace_id)
  where pending;

create table evaluator_import_retention_cutoffs (
  project_id text primary key references projects(id) on delete cascade,
  trace_timestamp_before timestamptz not null,
  updated_at timestamptz not null default clock_timestamp()
);

comment on table evaluator_trace_feed is
  'Latest successfully materialized trace/observation activity per project trace for evaluator-feed cursors. Scores never update this table.';
comment on table evaluator_trace_feed_activities is
  'Idempotency ledger for materialized ingest batches published into the evaluator trace feed.';
comment on table evaluator_trace_feed_watermarks is
  'Durable per-project publication high-water marks for commit-ordered evaluator cursors.';
comment on table evaluator_score_receipts is
  'First-write timestamp, materialization state, and request identity for retry-idempotent native evaluator scores.';
comment on table evaluator_import_trace_state is
  'Durable current snapshot, fenced run generation, and fail-closed pending barrier for pull-imported traces.';
comment on table evaluator_import_retention_cutoffs is
  'Monotonic trace timestamp cutoff preventing pull imports from resurrecting retention-expired data.';
