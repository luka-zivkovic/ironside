import { createClickHouseClient } from "@ironside/clickhouse";
import {
  claimOwnerSetup,
  createProject,
  getOwnerAuthState,
  issueRecoveryChallenge,
  issueSetupChallenge,
  listActiveAuthChallenges,
  runMigrations
} from "@ironside/db";
import { createIngestQueue } from "@ironside/queue";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMachineCredential } from "../src/lib/machine-credentials.js";
import { generateOwnerChallengeToken, hashOwnerSecret } from "../src/lib/owner-secrets.js";
import { hashOwnerPassword, verifyOwnerPassword } from "../src/lib/passwords.js";

const config = loadConfig();
const adminPool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);
const origin = "http://localhost:5174";
const schemaNames = [`owner_auth_${ulid().toLowerCase()}`, `owner_auth_fresh_${ulid().toLowerCase()}`];
let pool: Pool;
let freshPool: Pool;
let app: ReturnType<typeof createApp>;

function schemaPool(schema: string): Pool {
  return new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema}` });
}

function authRequest(path: string, init?: RequestInit, cookie?: string, address = "198.51.100.10") {
  return app.request(path, {
    ...init,
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": address,
      ...(cookie ? { cookie } : {}),
      ...init?.headers
    }
  });
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

function responseCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("response did not set a cookie");
  return header.split(";", 1)[0]!;
}

beforeAll(async () => {
  for (const schema of schemaNames) await adminPool.query(`create schema ${schema}`);
  pool = schemaPool(schemaNames[0]!);
  freshPool = schemaPool(schemaNames[1]!);
  await runMigrations(pool);
  await runMigrations(freshPool);
  app = createApp({
    pgPool: pool,
    clickhouse,
    redis,
    storage,
    queue,
    webOrigins: [origin],
    defaultRateLimitPerMinute: 10_000,
    authSecureCookies: false,
    authRateLimitPerWindow: 50,
    authTrustProxy: true
  });
});

afterAll(async () => {
  await pool.end();
  await freshPool.end();
  for (const schema of schemaNames) await adminPool.query(`drop schema ${schema} cascade`);
  await adminPool.end();
  await queue.close();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

describe.sequential("owner password hashing", () => {
  it("rejects non-positive authentication security configuration", () => {
    expect(loadConfig({}).authSecureCookies).toBe(true);
    expect(loadConfig({ AUTH_INSECURE_COOKIES: "true" }).authSecureCookies).toBe(false);
    expect(() => loadConfig({ AUTH_SESSION_IDLE_TTL_SECONDS: "0" })).toThrow(
      "AUTH_SESSION_IDLE_TTL_SECONDS must be a positive integer"
    );
    expect(() => loadConfig({ AUTH_RATE_LIMIT_PER_15_MINUTES: "NaN" })).toThrow(
      "AUTH_RATE_LIMIT_PER_15_MINUTES must be a positive integer"
    );
  });

  it("accepts only exact, credential-safe browser origins", () => {
    expect(loadConfig({ WEB_ORIGINS: "https://ironside.example/, http://localhost:5174" }).webOrigins).toEqual([
      "https://ironside.example",
      "http://localhost:5174"
    ]);
    expect(loadConfig({ WEB_ORIGINS: "https://ironside.example,https://ironside.example" }).webOrigins).toEqual([
      "https://ironside.example"
    ]);
    expect(() => loadConfig({ WEB_ORIGINS: "*" })).toThrow("invalid origin");
    expect(() => loadConfig({ WEB_ORIGINS: "https://ironside.example/app" })).toThrow(
      "exact http(s) origins"
    );
  });

  it("uses a salted scrypt encoding and verifies in constant-time-compatible form", async () => {
    const first = await hashOwnerPassword("correct horse battery staple");
    const second = await hashOwnerPassword("correct horse battery staple");
    expect(first).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(first).not.toBe(second);
    await expect(verifyOwnerPassword("correct horse battery staple", first)).resolves.toBe(true);
    await expect(verifyOwnerPassword("wrong password", first)).resolves.toBe(false);
  });
});

describe.sequential("fresh owner setup", () => {
  it("creates the first organization and exactly one owner without storing plaintext", async () => {
    expect(await getOwnerAuthState(freshPool)).toEqual({ state: "setup" });
    const issued = generateOwnerChallengeToken("setup");
    const challenge = await issueSetupChallenge(
      freshPool,
      issued.tokenHash,
      new Date(Date.now() + 60_000)
    );
    const passwordHash = await hashOwnerPassword("fresh-install-password");
    const owner = await claimOwnerSetup(freshPool, {
      challengeId: challenge.id,
      tokenHash: issued.tokenHash,
      username: "owner",
      usernameNormalized: "owner",
      passwordHash,
      defaultOrganizationName: "Ironside"
    });
    expect(owner.organizationName).toBe("Ironside");
    expect((await freshPool.query("select count(*)::int as count from organizations")).rows[0].count).toBe(1);
    expect((await freshPool.query("select count(*)::int as count from owner_principals")).rows[0].count).toBe(1);

    const persisted = await freshPool.query<{ password_hash: string }>(
      "select password_hash from owner_principals"
    );
    expect(persisted.rows[0]!.password_hash).toBe(passwordHash);
    expect(persisted.rows[0]!.password_hash).not.toContain("fresh-install-password");
    expect(await listActiveAuthChallenges(freshPool, "setup")).toEqual([]);
  });
});

describe.sequential("owner auth HTTP flow", () => {
  let organizationId: string;
  let machineToken: string;
  let ownerCookie: string;

  it("rejects cross-site setup before consuming the capability", async () => {
    const issued = generateOwnerChallengeToken("setup");
    await issueSetupChallenge(pool, issued.tokenHash, new Date(Date.now() + 60_000));
    const response = await app.request("/api/auth/setup", {
      ...jsonPost({ token: issued.token, username: "owner", password: "owner-password-value" }),
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site"
      }
    });
    expect(response.status).toBe(403);
    expect((await listActiveAuthChallenges(pool, "setup")).length).toBe(1);

    const missingOrigin = await app.request(
      "/api/auth/setup",
      jsonPost({ token: issued.token, username: "owner", password: "owner-password-value" })
    );
    expect(missingOrigin.status).toBe(403);

    await pool.query(
      "update owner_auth_challenges set expires_at = now() - interval '1 second' where token_hash = $1",
      [issued.tokenHash]
    );
    const expired = await authRequest(
      "/api/auth/setup",
      jsonPost({ token: issued.token, username: "owner", password: "owner-password-value" })
    );
    expect(expired.status).toBe(401);
  });

  it("atomically creates the first organization under a concurrent double-submit", async () => {
    const issued = generateOwnerChallengeToken("setup");
    await issueSetupChallenge(pool, issued.tokenHash, new Date(Date.now() + 60_000));
    const request = () =>
      authRequest(
        "/api/auth/setup",
        jsonPost({ token: issued.token, username: "Owner.Admin", password: "owner-password-value" })
      );
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 401]);
    const success = responses.find((response) => response.status === 201)!;
    ownerCookie = responseCookie(success);
    const session = await success.clone().json() as { organizationId: string };
    organizationId = session.organizationId;
    expect(success.headers.get("set-cookie")).toContain("HttpOnly");
    expect(success.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(success.headers.get("set-cookie")).not.toContain("Secure");

    const owners = await pool.query<{ organization_id: string; username_normalized: string }>(
      "select organization_id, username_normalized from owner_principals"
    );
    expect(owners.rows).toEqual([{ organization_id: organizationId, username_normalized: "owner.admin" }]);
    expect((await pool.query("select count(*)::int as count from organizations")).rows[0].count).toBe(1);

    const project = await createProject(pool, {
      id: `proj_${ulid()}`,
      organizationId,
      name: "owner-auth-project"
    });
    machineToken = (
      await createMachineCredential(pool, {
        projectId: project.id,
        organizationId,
        name: "owner auth test",
        preset: "ingest",
        expiresAt: null,
        actor: { principalId: null, username: "test" }
      })
    ).token;
  });

  it("does not accept a machine key as an owner session", async () => {
    const response = await app.request("/api/auth/session", {
      headers: { authorization: `Bearer ${machineToken}` }
    });
    expect(response.status).toBe(401);
  });

  it("resolves, refreshes, and revokes an HttpOnly owner session", async () => {
    const current = await authRequest("/api/auth/session", undefined, ownerCookie);
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      organizationId,
      organizationName: "Ironside",
      username: "Owner.Admin"
    });

    const logout = await authRequest("/api/auth/logout", { method: "POST" }, ownerCookie);
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await authRequest("/api/auth/session", undefined, ownerCookie)).status).toBe(401);
  });

  it("logs in with a rotated Secure cookie when secure mode is enabled", async () => {
    const secureApp = createApp({
      pgPool: pool,
      clickhouse,
      redis,
      storage,
      queue,
      webOrigins: [origin],
      defaultRateLimitPerMinute: 10_000,
      authSecureCookies: true,
      authRateLimitPerWindow: 50,
      authTrustProxy: true
    });
    const response = await secureApp.request("/api/auth/login", {
      ...jsonPost({ username: "owner.admin", password: "owner-password-value" }),
      headers: {
        "content-type": "application/json",
        origin,
        "sec-fetch-site": "same-origin",
        "x-forwarded-for": "198.51.100.11"
      }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Secure");
    ownerCookie = responseCookie(response);
  });

  it("rejects an expired session even when the browser still sends its cookie", async () => {
    const response = await authRequest(
      "/api/auth/login",
      jsonPost({ username: "owner.admin", password: "owner-password-value" }),
      undefined,
      "198.51.100.15"
    );
    expect(response.status).toBe(200);
    const expiringCookie = responseCookie(response);
    const token = expiringCookie.slice(expiringCookie.indexOf("=") + 1);
    const tokenHash = hashOwnerSecret(token);
    await pool.query(
      `update owner_sessions
          set idle_expires_at = now() - interval '1 second',
              absolute_expires_at = now() - interval '1 second'
        where token_hash = $1`,
      [tokenHash]
    );
    expect((await authRequest("/api/auth/session", undefined, expiringCookie)).status).toBe(401);

    const stored = await pool.query<{ token_hash: string }>(
      "select token_hash from owner_sessions where token_hash = $1",
      [tokenHash]
    );
    expect(stored.rows).toEqual([{ token_hash: tokenHash }]);
    expect(JSON.stringify(stored.rows)).not.toContain(token);
  });

  it("rate-limits login by client address without globally locking the owner username", async () => {
    const rateLimitIdentity = `test-${ulid()}`;
    const rateLimitSubject = `missing-${ulid().toLowerCase()}`;
    const limitedApp = createApp({
      pgPool: pool,
      clickhouse,
      redis,
      storage,
      queue,
      webOrigins: [origin],
      defaultRateLimitPerMinute: 10_000,
      authSecureCookies: false,
      authRateLimitPerWindow: 2,
      authTrustProxy: true
    });
    const attempt = (address = rateLimitIdentity) =>
      limitedApp.request("/api/auth/login", {
        ...jsonPost({ username: rateLimitSubject, password: "definitely-wrong" }),
        headers: {
          "content-type": "application/json",
          origin,
          "sec-fetch-site": "same-origin",
          "x-forwarded-for": address
        }
      });
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);

    // Exhausting one source address must not create a deployment-wide
    // username lockout for the real owner arriving from another address.
    expect((await attempt(`${rateLimitIdentity}-other`)).status).toBe(401);
  });

  it("uses one-time recovery to replace the password and revoke every session", async () => {
    const issued = generateOwnerChallengeToken("recovery");
    await issueRecoveryChallenge(pool, issued.tokenHash, new Date(Date.now() + 60_000));
    const recovery = await authRequest(
      "/api/auth/recover",
      jsonPost({ token: issued.token, password: "replacement-owner-password" }),
      ownerCookie,
      "198.51.100.12"
    );
    expect(recovery.status).toBe(204);
    expect((await authRequest("/api/auth/session", undefined, ownerCookie)).status).toBe(401);

    const oldLogin = await authRequest(
      "/api/auth/login",
      jsonPost({ username: "owner.admin", password: "owner-password-value" }),
      undefined,
      "198.51.100.13"
    );
    expect(oldLogin.status).toBe(401);
    const newLogin = await authRequest(
      "/api/auth/login",
      jsonPost({ username: "owner.admin", password: "replacement-owner-password" }),
      undefined,
      "198.51.100.14"
    );
    expect(newLogin.status).toBe(200);
    expect((await listActiveAuthChallenges(pool, "recovery")).length).toBe(0);

    const stored = await pool.query<{ token_hash: string }>(
      "select token_hash from owner_auth_challenges order by created_at"
    );
    expect(stored.rows.every((row) => /^[0-9a-f]{64}$/.test(row.token_hash))).toBe(true);
    expect(stored.rows.some((row) => row.token_hash === hashOwnerSecret(issued.token))).toBe(true);
    expect(JSON.stringify(stored.rows)).not.toContain(issued.token);
  });
});
