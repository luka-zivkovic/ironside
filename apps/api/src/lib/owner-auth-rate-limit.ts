import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { Redis } from "ioredis";

export function ownerAuthClientAddress(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
    const realIp = c.req.header("x-real-ip")?.trim();
    if (realIp) return realIp;
  }

  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

export async function consumeOwnerAuthRateLimit(
  redis: Redis,
  input: {
    scope: string;
    identity: string;
    limit: number;
    windowSeconds: number;
  }
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const identityHash = createHash("sha256").update(input.identity).digest("hex");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const window = Math.floor(nowSeconds / input.windowSeconds);
  const key = `ratelimit:owner-auth:${input.scope}:${identityHash}:${window}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, input.windowSeconds);
  return {
    allowed: count <= input.limit,
    retryAfterSeconds: input.windowSeconds - (nowSeconds % input.windowSeconds)
  };
}
