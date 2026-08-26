import {
  claimOwnerRecovery,
  claimOwnerSetup,
  createOwnerSession,
  findOwnerByUsername,
  getOwnerAuthState,
  listActiveAuthChallenges,
  OwnerAuthError,
  recordOwnerLoginFailure,
  revokeOwnerSession,
  type OwnerPrincipal,
  type OwnerSession
} from "@ironside/db";
import {
  ownerLoginRequestSchema,
  ownerRecoveryRequestSchema,
  ownerSetupRequestSchema,
  type OwnerSessionResponse
} from "@ironside/shared";
import { Hono, type Context } from "hono";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import {
  clearOwnerSessionCookie,
  getOwnerSessionToken,
  resolveRequestOwnerSession,
  setOwnerSessionCookie,
  trustedBrowserMutation
} from "../middleware/owner-session.js";
import { consumeOwnerAuthRateLimit, ownerAuthClientAddress } from "../lib/owner-auth-rate-limit.js";
import {
  constantTimeHashMatch,
  generateOwnerSessionToken,
  hashOwnerSecret
} from "../lib/owner-secrets.js";
import { hashOwnerPassword, verifyOwnerPassword } from "../lib/passwords.js";

const AUTH_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const DEFAULT_ORGANIZATION_NAME = "Ironside";

export interface OwnerAuthRouteDeps {
  pool: Pool;
  redis: Redis;
  webOrigins: string[];
  secureCookies: boolean;
  sessionIdleTtlSeconds: number;
  sessionAbsoluteTtlSeconds: number;
  rateLimitPerWindow: number;
  trustProxy: boolean;
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function toResponse(session: OwnerSession): OwnerSessionResponse {
  return {
    principalId: session.principalId,
    organizationId: session.organizationId,
    organizationName: session.organizationName,
    username: session.username,
    createdAt: session.createdAt.toISOString(),
    idleExpiresAt: session.idleExpiresAt.toISOString(),
    absoluteExpiresAt: session.absoluteExpiresAt.toISOString()
  };
}

async function applyRateLimit(
  c: Context,
  deps: OwnerAuthRouteDeps,
  scope: string,
  secondaryIdentity?: string,
  includeAddress = true
): Promise<Response | null> {
  const address = ownerAuthClientAddress(c, deps.trustProxy);
  const identities = [
    ...(includeAddress ? [`ip:${address}`] : []),
    ...(secondaryIdentity ? [`subject:${secondaryIdentity}`] : [])
  ];
  let retryAfterSeconds = 0;
  for (const identity of identities) {
    const result = await consumeOwnerAuthRateLimit(deps.redis, {
      scope,
      identity,
      limit: deps.rateLimitPerWindow,
      windowSeconds: AUTH_RATE_LIMIT_WINDOW_SECONDS
    });
    retryAfterSeconds = Math.max(retryAfterSeconds, result.retryAfterSeconds);
    if (!result.allowed) {
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json({ error: "too many authentication attempts" }, 429);
    }
  }
  return null;
}

async function matchChallenge(pool: Pool, purpose: "setup" | "recovery", token: string) {
  const tokenHash = hashOwnerSecret(token);
  const active = await listActiveAuthChallenges(pool, purpose);
  const challenge = active.find((candidate) => constantTimeHashMatch(tokenHash, candidate.tokenHash));
  return challenge ? { challenge, tokenHash } : null;
}

async function establishSession(
  c: Context,
  deps: OwnerAuthRouteDeps,
  principal: Pick<OwnerPrincipal, "id">,
  replacedToken: string | null
): Promise<OwnerSession> {
  const issued = generateOwnerSessionToken();
  const now = Date.now();
  const absoluteExpiresAt = new Date(now + deps.sessionAbsoluteTtlSeconds * 1000);
  const idleExpiresAt = new Date(
    Math.min(now + deps.sessionIdleTtlSeconds * 1000, absoluteExpiresAt.getTime())
  );
  const session = await createOwnerSession(deps.pool, {
    principalId: principal.id,
    tokenHash: issued.tokenHash,
    idleExpiresAt,
    absoluteExpiresAt,
    ...(replacedToken ? { replacedTokenHash: hashOwnerSecret(replacedToken) } : {})
  });
  setOwnerSessionCookie(c, issued.token, {
    secure: deps.secureCookies,
    maxAgeSeconds: Math.min(deps.sessionIdleTtlSeconds, deps.sessionAbsoluteTtlSeconds)
  });
  return session;
}

let dummyPasswordHash: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHash ??= hashOwnerPassword("not-a-real-owner-password");
  return dummyPasswordHash;
}

export function ownerAuthRoutes(deps: OwnerAuthRouteDeps): Hono {
  const app = new Hono();
  app.use("*", trustedBrowserMutation(deps.webOrigins));

  app.get("/status", async (c) => c.json(await getOwnerAuthState(deps.pool), 200));

  app.post("/setup", async (c) => {
    const limited = await applyRateLimit(c, deps, "setup");
    if (limited) return limited;
    const parsed = ownerSetupRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);

    const matched = await matchChallenge(deps.pool, "setup", parsed.data.token);
    if (!matched) return c.json({ error: "invalid or expired setup capability" }, 401);

    try {
      const passwordHash = await hashOwnerPassword(parsed.data.password);
      const principal = await claimOwnerSetup(deps.pool, {
        challengeId: matched.challenge.id,
        tokenHash: matched.tokenHash,
        username: parsed.data.username,
        usernameNormalized: normalizeUsername(parsed.data.username),
        passwordHash,
        defaultOrganizationName: DEFAULT_ORGANIZATION_NAME
      });
      const session = await establishSession(c, deps, principal, getOwnerSessionToken(c));
      return c.json(toResponse(session), 201);
    } catch (error) {
      if (error instanceof OwnerAuthError) {
        if (error.code === "setup_closed") return c.json({ error: "owner setup is already complete" }, 409);
        if (error.code === "challenge_invalid") {
          return c.json({ error: "invalid or expired setup capability" }, 401);
        }
      }
      throw error;
    }
  });

  app.post("/login", async (c) => {
    const parsed = ownerLoginRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid credentials" }, 401);
    const usernameNormalized = normalizeUsername(parsed.data.username);
    // A deployment has one owner. A hard, username-wide bucket would let any
    // remote caller lock that sole owner out from every address, so login is
    // bounded by the client address instead. Scrypt still makes each allowed
    // guess deliberately expensive.
    const limited = await applyRateLimit(c, deps, "login");
    if (limited) return limited;

    const principal = await findOwnerByUsername(deps.pool, usernameNormalized);
    const valid = await verifyOwnerPassword(
      parsed.data.password,
      principal?.passwordHash ?? (await getDummyPasswordHash())
    );
    if (!principal || !valid) {
      await recordOwnerLoginFailure(deps.pool, principal);
      return c.json({ error: "invalid credentials" }, 401);
    }

    const session = await establishSession(c, deps, principal, getOwnerSessionToken(c));
    return c.json(toResponse(session), 200);
  });

  app.get("/session", async (c) => {
    const token = getOwnerSessionToken(c);
    const limited = await applyRateLimit(c, {
      ...deps,
      rateLimitPerWindow: Math.max(300, deps.rateLimitPerWindow * 30)
    }, "session", token ? hashOwnerSecret(token) : undefined, !token);
    if (limited) return limited;
    const session = await resolveRequestOwnerSession(deps.pool, c, deps.sessionIdleTtlSeconds);
    if (!session) {
      clearOwnerSessionCookie(c, deps.secureCookies);
      return c.json({ error: "owner session required" }, 401);
    }
    const remainingSeconds = Math.max(
      0,
      Math.floor((Math.min(session.idleExpiresAt.getTime(), session.absoluteExpiresAt.getTime()) - Date.now()) / 1000)
    );
    setOwnerSessionCookie(c, token!, { secure: deps.secureCookies, maxAgeSeconds: remainingSeconds });
    return c.json(toResponse(session), 200);
  });

  app.post("/logout", async (c) => {
    const token = getOwnerSessionToken(c);
    const limited = await applyRateLimit(c, {
      ...deps,
      rateLimitPerWindow: Math.max(30, deps.rateLimitPerWindow * 3)
    }, "logout", token ? hashOwnerSecret(token) : undefined, !token);
    if (limited) return limited;
    if (token) await revokeOwnerSession(deps.pool, hashOwnerSecret(token));
    clearOwnerSessionCookie(c, deps.secureCookies);
    return c.body(null, 204);
  });

  app.post("/recover", async (c) => {
    const limited = await applyRateLimit(c, deps, "recovery");
    if (limited) return limited;
    const parsed = ownerRecoveryRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    const matched = await matchChallenge(deps.pool, "recovery", parsed.data.token);
    if (!matched) return c.json({ error: "invalid or expired recovery capability" }, 401);

    try {
      const passwordHash = await hashOwnerPassword(parsed.data.password);
      await claimOwnerRecovery(deps.pool, {
        challengeId: matched.challenge.id,
        tokenHash: matched.tokenHash,
        passwordHash
      });
      clearOwnerSessionCookie(c, deps.secureCookies);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof OwnerAuthError && error.code === "challenge_invalid") {
        return c.json({ error: "invalid or expired recovery capability" }, 401);
      }
      throw error;
    }
  });

  return app;
}
