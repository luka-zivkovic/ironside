import { runMigrations } from "@ironside/db";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  __testing,
  createMachineCredential,
  generateMachineCredentialToken,
  hashMachineCredential,
  resolveMachineCredential
} from "../src/lib/machine-credentials.js";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://ironside:ironside@localhost:5433/ironside"
});
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6380");

let projectId: string;
let organizationId: string;

beforeAll(async () => {
  await runMigrations(pool);
  organizationId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    organizationId,
    "test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, organizationId, "test-project"]
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [organizationId]);
  await pool.end();
  redis.disconnect();
});

function createCredential(name: string, expiresAt: Date | null = null) {
  return createMachineCredential(pool, {
    projectId,
    organizationId,
    name,
    preset: "ingest",
    expiresAt,
    actor: { principalId: null, username: "test-owner" }
  });
}

describe("machine credentials", () => {
  it("uses one 256-bit scoped token class", () => {
    expect(generateMachineCredentialToken()).toMatch(/^ironside_sc_[0-9a-f]{64}$/);
    expect(generateMachineCredentialToken()).not.toBe(generateMachineCredentialToken());
  });

  it("stores only the hash, audit attribution, and capability snapshot", async () => {
    const created = await createCredential("scoped-ingest");
    const row = await pool.query<{
      token_hash: string;
      preset: string;
      capabilities: string[];
      created_by_username: string;
    }>(
      `select token_hash, preset, capabilities, created_by_username
         from machine_credentials where id = $1`,
      [created.id]
    );
    expect(row.rows[0]).toMatchObject({
      token_hash: hashMachineCredential(created.token),
      preset: "ingest",
      capabilities: ["ingest", "media:write"],
      created_by_username: "test-owner"
    });
    expect(JSON.stringify(row.rows[0])).not.toContain(created.token);
    await expect(resolveMachineCredential(pool, redis, created.token)).resolves.toMatchObject({
      projectId,
      capabilities: ["ingest", "media:write"]
    });
  });

  it("uses the bounded Redis cache after a successful lookup", async () => {
    const created = await createCredential("cache-key");
    await resolveMachineCredential(pool, redis, created.token);
    const cacheKey = `${__testing.CACHE_PREFIX}${hashMachineCredential(created.token)}`;
    expect(await redis.get(cacheKey)).toContain(projectId);

    await pool.query(
      "update machine_credentials set revoked_at = now(), revoked_by_username = 'test' where id = $1",
      [created.id]
    );
    expect((await resolveMachineCredential(pool, redis, created.token))?.projectId).toBe(projectId);
    await redis.del(cacheKey);
    expect(await resolveMachineCredential(pool, redis, created.token)).toBeNull();
  });

  it("rejects unknown and malformed tokens", async () => {
    expect(await resolveMachineCredential(pool, redis, "not-a-key")).toBeNull();
    expect(await resolveMachineCredential(pool, redis, generateMachineCredentialToken())).toBeNull();
  });

  it("rejects an expired credential even when an invalid cache entry exists", async () => {
    const created = await createCredential("expiring", new Date(Date.now() + 60 * 60 * 1000));
    const resolved = await resolveMachineCredential(pool, redis, created.token);
    const cacheKey = `${__testing.CACHE_PREFIX}${hashMachineCredential(created.token)}`;
    await redis.set(
      cacheKey,
      JSON.stringify({ ...resolved, expiresAt: new Date(0).toISOString() }),
      "EX",
      60
    );
    expect(await resolveMachineCredential(pool, redis, created.token)).toBeNull();
  });

  it("never overwrites a revocation sentinel", async () => {
    const created = await createCredential("sentinel-key");
    const cacheKey = `${__testing.CACHE_PREFIX}${hashMachineCredential(created.token)}`;
    await redis.set(cacheKey, __testing.REVOKED_SENTINEL, "EX", 60);
    expect(await resolveMachineCredential(pool, redis, created.token)).toBeNull();
    expect(await redis.get(cacheKey)).toBe(__testing.REVOKED_SENTINEL);
  });
});
