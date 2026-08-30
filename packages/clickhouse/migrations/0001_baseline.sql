create table if not exists traces
(
    project_id       LowCardinality(String),
    id               String,
    timestamp        DateTime64(3),
    name             Nullable(String),
    user_id          Nullable(String),
    session_id       Nullable(String),
    environment      Nullable(String),
    release          Nullable(String),
    version          Nullable(String),
    tags             Array(String),
    metadata         Map(LowCardinality(String), String),
    input            Nullable(String) codec (ZSTD(3)),
    output           Nullable(String) codec (ZSTD(3)),
    event_ts         DateTime64(6) default now64(6),
    is_deleted       UInt8 default 0,

    index idx_metadata_key mapKeys(metadata) type bloom_filter granularity 1,
    index idx_metadata_value mapValues(metadata) type bloom_filter granularity 1,
    index idx_tags tags type bloom_filter granularity 1,
    index idx_environment environment type bloom_filter granularity 1,
    index idx_trace_id id type bloom_filter(0.01) granularity 1
)
engine = ReplacingMergeTree(event_ts, is_deleted)
partition by toYYYYMM(timestamp)
order by (project_id, toDate(timestamp), id);

create table if not exists observations
(
    project_id             LowCardinality(String),
    id                     String,
    trace_id               String,
    parent_observation_id  Nullable(String),
    type                   LowCardinality(String),
    name                   Nullable(String),
    start_time             DateTime64(3),
    end_time               Nullable(DateTime64(3)),
    level                  LowCardinality(String) default 'default',
    status_message         Nullable(String),
    model                  Nullable(String),
    model_parameters       Map(LowCardinality(String), String),
    input                  Nullable(String) codec (ZSTD(3)),
    output                 Nullable(String) codec (ZSTD(3)),
    usage_details          Map(LowCardinality(String), UInt64),
    cost_details           Map(LowCardinality(String), Decimal64(9)),
    completion_start_time  Nullable(DateTime64(3)),
    metadata               Map(LowCardinality(String), String),
    event_ts               DateTime64(6) default now64(6),
    is_deleted             UInt8 default 0,

    index idx_trace_id trace_id type bloom_filter granularity 1,
    index idx_metadata_key mapKeys(metadata) type bloom_filter granularity 1,
    index idx_metadata_value mapValues(metadata) type bloom_filter granularity 1
)
engine = ReplacingMergeTree(event_ts, is_deleted)
partition by toYYYYMM(start_time)
order by (project_id, toDate(start_time), trace_id, id);

create table if not exists scores
(
    project_id       LowCardinality(String),
    id               String,
    trace_id         String,
    observation_id   Nullable(String),
    name             LowCardinality(String),
    data_type        LowCardinality(String),
    value            Nullable(Float64),
    string_value     Nullable(String),
    source           LowCardinality(String),
    import_source    LowCardinality(Nullable(String)),
    comment          Nullable(String),
    metadata         Map(LowCardinality(String), String),
    timestamp        DateTime64(3) default now64(3),
    event_ts         DateTime64(6) default now64(6),
    is_deleted       UInt8 default 0,

    index idx_trace_id trace_id type bloom_filter granularity 1
)
engine = ReplacingMergeTree(event_ts, is_deleted)
partition by toYYYYMM(timestamp)
order by (project_id, toDate(timestamp), trace_id, id);

create table if not exists raw_event_refs
(
    project_id   LowCardinality(String),
    trace_id     String,
    object_key   String,
    received_at  DateTime64(6),
    event_ts     DateTime64(6),
    applied      UInt8,

    projection raw_event_refs_by_object
    (
      select project_id, object_key, trace_id, applied
      order by (project_id, object_key, trace_id)
    )
)
engine = ReplacingMergeTree(applied)
partition by toYYYYMM(received_at)
order by (project_id, trace_id, object_key)
settings deduplicate_merge_projection_mode = 'rebuild';

create table if not exists raw_event_trace_retention
(
    project_id  LowCardinality(String),
    trace_id    String,
    expired_at  DateTime64(6)
)
engine = MergeTree
order by (project_id, trace_id, expired_at);

create table if not exists evaluator_trace_retention
(
    project_id LowCardinality(String),
    trace_id   String,
    expired_at DateTime64(6)
)
engine = ReplacingMergeTree(expired_at)
order by (project_id, trace_id);
