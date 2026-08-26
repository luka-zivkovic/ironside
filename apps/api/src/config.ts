import type { StorageConfig } from "@ironside/storage";
import { DEFAULT_TRACE_QUIET_PERIOD_SECONDS } from "@ironside/shared";

export interface Config {
  port: number;
  databaseUrl: string;
  clickhouse: {
    url: string;
    username: string;
    password: string;
    database: string;
  };
  redisUrl: string;
  storage: StorageConfig;
  /** Exact browser origins allowed to send credentialed owner-session requests. */
  webOrigins: string[];
  /** HttpOnly owner-session cookies are Secure unless this explicit local/LAN-only escape hatch is true. */
  authSecureCookies: boolean;
  /** Sliding inactivity lifetime for an owner session. */
  authSessionIdleTtlSeconds: number;
  /** Hard lifetime for an owner session, never extended by activity. */
  authSessionAbsoluteTtlSeconds: number;
  /** Setup/recovery capability lifetime. */
  authChallengeTtlSeconds: number;
  /** Attempts allowed per authentication limiter identity in each 15-minute window. */
  authRateLimitPerWindow: number;
  /** Trust X-Forwarded-For/X-Real-IP for auth limiting only when a trusted proxy is the sole API ingress. */
  authTrustProxy: boolean;
  /** Platform-default per-project ingest rate limit (requests/minute), overridable per-project via projects.rate_limit_per_minute. */
  defaultRateLimitPerMinute: number;
  /** Platform-default inactivity window before compatibility consumers may read a trace. */
  defaultTraceQuietPeriodSeconds: number;
  /** Bearer token required to scrape GET /metrics. Unset = the endpoint is disabled entirely (404) — instance metrics are never exposed unauthenticated on the public API port. */
  metricsToken: string | null;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function exactWebOrigins(value: string | undefined): string[] {
  const origins = (value ?? "http://localhost:5174")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (origins.length === 0) throw new Error("WEB_ORIGINS must contain at least one exact origin");
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`WEB_ORIGINS contains an invalid origin: ${origin}`);
    }
    if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`WEB_ORIGINS must contain exact http(s) origins without paths or wildcards: ${origin}`);
    }
  }
  return [...new Set(origins)];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8788),
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
    webOrigins: exactWebOrigins(env.WEB_ORIGINS),
    authSecureCookies: env.AUTH_INSECURE_COOKIES !== "true",
    authSessionIdleTtlSeconds: positiveInteger(
      env.AUTH_SESSION_IDLE_TTL_SECONDS,
      12 * 60 * 60,
      "AUTH_SESSION_IDLE_TTL_SECONDS"
    ),
    authSessionAbsoluteTtlSeconds: positiveInteger(
      env.AUTH_SESSION_ABSOLUTE_TTL_SECONDS,
      7 * 24 * 60 * 60,
      "AUTH_SESSION_ABSOLUTE_TTL_SECONDS"
    ),
    authChallengeTtlSeconds: positiveInteger(
      env.AUTH_CHALLENGE_TTL_SECONDS,
      15 * 60,
      "AUTH_CHALLENGE_TTL_SECONDS"
    ),
    authRateLimitPerWindow: positiveInteger(
      env.AUTH_RATE_LIMIT_PER_15_MINUTES,
      10,
      "AUTH_RATE_LIMIT_PER_15_MINUTES"
    ),
    authTrustProxy: env.AUTH_TRUST_PROXY === "true",
    defaultRateLimitPerMinute: Number(env.DEFAULT_RATE_LIMIT_PER_MINUTE ?? 300),
    defaultTraceQuietPeriodSeconds: Number(
      env.DEFAULT_TRACE_QUIET_PERIOD_SECONDS ?? DEFAULT_TRACE_QUIET_PERIOD_SECONDS
    ),
    metricsToken: env.METRICS_TOKEN ?? null
  };
}
