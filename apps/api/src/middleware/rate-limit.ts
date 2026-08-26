import type { MiddlewareHandler } from "hono";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { getProject } from "@ironside/db";
import type { AuthEnv } from "./auth.js";

const RATE_LIMIT_PREFIX = "ratelimit:";
const QUOTA_CACHE_PREFIX = "quota:ratelimit:";
const QUOTA_CACHE_TTL_SECONDS = 60;

export interface RateLimitOptions {
  /** Max requests allowed per project within one window, when the project has no override. */
  defaultLimit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  pool: Pool;
  /**
   * Namespaces this limiter's Redis counters so route groups with
   * different policies (e.g. ingest vs the raw-events scan) don't share a
   * budget. Unset keeps the original `ratelimit:{projectId}:{window}` key
   * shape — the ingest limiter's live counters stay valid.
   */
  scope?: string;
  /**
   * When false, the per-project `projects.rate_limit_per_minute` override
   * is ignored and `defaultLimit` always applies. That override is the
   * INGEST quota knob — a limiter with its own policy (raw-events) must
   * not inherit a project's raised ingest limit. Defaults to true.
   */
  useProjectOverride?: boolean;
}

// Per-project overrides live in Postgres (packages/db/src/projects.ts,
// projects.rate_limit_per_minute) but the rate limiter runs on every
// single ingest request, so a DB round trip per request is unacceptable.
// Cached in Redis the same way machine credential resolution is cached —
// reusing an established pattern rather than inventing a new caching
// layer. A stale cache entry (project's limit changed less than
// QUOTA_CACHE_TTL_SECONDS ago) means the OLD limit is enforced for up to
// a minute after an admin changes it — acceptable for a quota control,
// unlike machine-credential revocation, which must be immediate for security
// reasons.
async function resolveLimit(pool: Pool, redis: Redis, projectId: string, defaultLimit: number): Promise<number> {
  const cacheKey = `${QUOTA_CACHE_PREFIX}${projectId}`;
  const cached = await redis.get(cacheKey);
  if (cached !== null) {
    return cached === "" ? defaultLimit : Number(cached);
  }

  const project = await getProject(pool, projectId);
  const limit = project?.rateLimitPerMinute ?? null;
  // Cache "" for "no override" so a project with no override doesn't hit
  // Postgres on every single request either — only re-checked once per TTL.
  await redis.set(cacheKey, limit === null ? "" : String(limit), "EX", QUOTA_CACHE_TTL_SECONDS);
  return limit ?? defaultLimit;
}

/**
 * Fixed-window per-project rate limiter, backed by the same shared Redis
 * instance every route already gets via machineAuth — no separate
 * connection pool, no in-memory per-process state (unlike coeval's
 * hand-rolled in-memory token bucket, explicitly marked there as a
 * stopgap because it doesn't share state across horizontally-scaled
 * instances or survive restarts; ironside already has shared Redis
 * threaded through every route, so there's no reason to repeat that
 * shortcut here).
 *
 * Must run AFTER machineAuth (needs `c.get("projectId")`) — mounted
 * per-route-group the same way machineAuth is.
 *
 * Fixed-window (not sliding-window/token-bucket) is a deliberate
 * simplicity choice: it allows up to 2x `limit` requests across a window
 * boundary in the worst case, which is an acceptable trade for a
 * self-hosted single-tenant-per-deployment product where this exists to
 * catch a runaway/misconfigured client, not to bill by the request.
 */
export function rateLimit(redis: Redis, options: RateLimitOptions): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const projectId = c.get("projectId");
    const limit =
      options.useProjectOverride === false
        ? options.defaultLimit
        : await resolveLimit(options.pool, redis, projectId, options.defaultLimit);

    const window = Math.floor(Date.now() / 1000 / options.windowSeconds);
    const scopePrefix = options.scope ? `${options.scope}:` : "";
    const key = `${RATE_LIMIT_PREFIX}${scopePrefix}${projectId}:${window}`;

    const count = await redis.incr(key);
    if (count === 1) {
      // Only the request that created this window's counter sets the
      // expiry — an EXPIRE on every INCR would race and could
      // repeatedly push the TTL out, never letting the window end.
      await redis.expire(key, options.windowSeconds);
    }

    if (count > limit) {
      const retryAfterSeconds = options.windowSeconds - (Math.floor(Date.now() / 1000) % options.windowSeconds);
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json(
        { error: `rate limit exceeded: ${limit} requests per ${options.windowSeconds}s per project` },
        429
      );
    }

    await next();
  };
}
