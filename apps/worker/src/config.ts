import type { StorageConfig } from "@ironside/storage";
import { DEFAULT_TRACE_QUIET_PERIOD_SECONDS } from "@ironside/shared";

export interface Config {
  databaseUrl: string;
  clickhouse: {
    url: string;
    username: string;
    password: string;
    database: string;
  };
  redisUrl: string;
  storage: StorageConfig;
  /** Platform-default ClickHouse retention window in days, for projects with no per-project retentionDays override. */
  defaultRetentionDays: number;
  /** Platform-default inactivity window before a trace is settled for automated consumers. */
  defaultTraceQuietPeriodSeconds: number;
  /** How often the scheduler polls for due exports/forwards/webhooks, in ms. */
  schedulerTickIntervalMs: number;
  /** How often the scheduler runs the global retention sweep, in ms. */
  retentionIntervalMs: number;
  /** How often durable pending ingest intents are reconciled into Redis. */
  ingestRecoveryIntervalMs: number;
  /** Maximum pending intents examined per recovery pass. */
  ingestRecoveryBatchSize: number;
  /** Destructive raw-retention commands require this literal opt-in. */
  rawRetentionExecutionEnabled: boolean;
  /** Port for the worker's own /metrics listener (the worker has no other HTTP surface). Not published in docker-compose by default. */
  metricsPort: number;
  /** Optional bearer token gating the worker's /metrics; null = unauthenticated (acceptable when the port isn't published/reachable). */
  metricsToken: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl:
      env.DATABASE_URL ?? "postgres://ironside:ironside@localhost:5433/ironside",
    clickhouse: {
      url: env.CLICKHOUSE_URL ?? "http://localhost:8123",
      username: env.CLICKHOUSE_USER ?? "ironside",
      password: env.CLICKHOUSE_PASSWORD ?? "ironside",
      database: env.CLICKHOUSE_DB ?? "ironside"
    },
    redisUrl: env.REDIS_URL ?? "redis://localhost:6380",
    storage: {
      endpoint: env.S3_ENDPOINT ?? "http://localhost:9010",
      region: env.S3_REGION ?? "us-east-1",
      accessKeyId: env.S3_ACCESS_KEY ?? "ironside",
      secretAccessKey: env.S3_SECRET_KEY ?? "ironside123", // gitleaks:allow — documented local-only Compose credential
      bucket: env.S3_BUCKET ?? "ironside-raw"
    },
    defaultRetentionDays: Number(env.DEFAULT_RETENTION_DAYS ?? 90),
    defaultTraceQuietPeriodSeconds: Number(
      env.DEFAULT_TRACE_QUIET_PERIOD_SECONDS ?? DEFAULT_TRACE_QUIET_PERIOD_SECONDS
    ),
    schedulerTickIntervalMs: Number(env.SCHEDULER_TICK_INTERVAL_MS ?? 30_000),
    retentionIntervalMs: Number(env.RETENTION_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
    ingestRecoveryIntervalMs: Number(env.INGEST_RECOVERY_INTERVAL_MS ?? 30_000),
    ingestRecoveryBatchSize: Number(env.INGEST_RECOVERY_BATCH_SIZE ?? 1_000),
    rawRetentionExecutionEnabled: env.RAW_RETENTION_EXECUTION_ENABLED === "true",
    metricsPort: Number(env.METRICS_PORT ?? 9464),
    metricsToken: env.METRICS_TOKEN ?? null
  };
}
