import { runMigrations as runPgMigrations } from "@ironside/db";
import { createClickHouseClient, runMigrations as runChMigrations } from "@ironside/clickhouse";
import { createIngestQueue } from "@ironside/queue";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { hashMachineCredential } from "../src/lib/machine-credentials.js";
import { createTestOwnerSession, ownerHeaders } from "./helpers/owner-session.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);
const app = createApp({
  pgPool: pool,
  clickhouse,
  redis,
  storage,
  queue,
  webOrigins: ["http://localhost:5174"],
  defaultRateLimitPerMinute: 10000
});

let projectId: string;
let otherProjectId: string;
let ownerCookie: string;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();
  const owner = await createTestOwnerSession(pool);
  ownerCookie = owner.cookie;
  projectId = `proj_${ulid()}`;
  otherProjectId = `proj_${ulid()}`;
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3), ($4, $2, $5)",
    [projectId, owner.organizationId, "credentials-test-main", otherProjectId, "credentials-test-other"]
  );
});

afterAll(async () => {
  await pool.query("delete from projects where id = any($1)", [[projectId, otherProjectId]]);
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

function ownerRequest(path: string, init?: RequestInit) {
  return app.request(path, { ...init, headers: ownerHeaders(ownerCookie, init?.headers) });
}

async function createCredential(
  targetProjectId: string,
  preset: "ingest" | "integration",
  name = `${preset}-${ulid()}`,
  expiresAt?: string | null
) {
  return ownerRequest(`/api/v1/projects/${targetProjectId}/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, preset, ...(expiresAt !== undefined && { expiresAt }) })
  });
}

describe("owner machine credential lifecycle", () => {
  it("requires an owner session", async () => {
    expect((await app.request(`/api/v1/projects/${projectId}/credentials`)).status).toBe(401);
  });

  it("lists scoped credentials without plaintext", async () => {
    const created = (await (await createCredential(projectId, "ingest", "list-only")).json()) as {
      id: string;
    };
    const res = await ownerRequest(`/api/v1/projects/${projectId}/credentials`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const body = (await res.json()) as {
      credentials: Array<{ id: string; preset: string; capabilities: string[]; token?: string }>;
    };
    expect(body.credentials.find((credential) => credential.id === created.id)).toMatchObject({
      preset: "ingest",
      capabilities: ["ingest", "media:write"]
    });
    expect(body.credentials.every((credential) => !("token" in credential))).toBe(true);
  });

  it("creates a scoped preset snapshot, attributes it, and discloses plaintext once", async () => {
    const res = await createCredential(projectId, "ingest", "staging worker");
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const created = (await res.json()) as {
      id: string;
      token: string;
      tokenPrefix: string;
      preset: string;
      capabilities: string[];
      createdBy: { username: string };
    };
    expect(created).toMatchObject({
      preset: "ingest",
      capabilities: ["ingest", "media:write"],
      createdBy: { username: "api-test-owner" }
    });
    expect(created.token).toMatch(/^ironside_sc_[0-9a-f]{64}$/);
    expect(created.token.startsWith(created.tokenPrefix)).toBe(true);

    const stored = await pool.query<{ token_hash: string; capabilities: string[] }>(
      "select token_hash, capabilities from machine_credentials where id = $1",
      [created.id]
    );
    expect(stored.rows[0]).toMatchObject({
      token_hash: hashMachineCredential(created.token),
      capabilities: ["ingest", "media:write"]
    });
    expect(JSON.stringify(stored.rows[0])).not.toContain(created.token);

    const listed = (await (
      await ownerRequest(`/api/v1/projects/${projectId}/credentials`)
    ).json()) as { credentials: Array<{ id: string; token?: string }> };
    expect(listed.credentials.find((credential) => credential.id === created.id)).not.toHaveProperty("token");
  });

  it("rejects caller-supplied capabilities and past expiry", async () => {
    const capabilities = await ownerRequest(`/api/v1/projects/${projectId}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "forged", preset: "ingest", capabilities: ["traces:read"] })
    });
    expect(capabilities.status).toBe(400);

    const expired = await createCredential(projectId, "integration", "expired", new Date(0).toISOString());
    expect(expired.status).toBe(400);
  });

  it("revokes a cache-primed scoped credential immediately and preserves its audit row", async () => {
    const createRes = await createCredential(projectId, "integration", "to revoke");
    const created = (await createRes.json()) as { id: string; token: string };
    const prime = await app.request("/api/public/traces?limit=1", {
      headers: { authorization: `Bearer ${created.token}` }
    });
    expect(prime.status).toBe(200);

    const revoke = await ownerRequest(`/api/v1/projects/${projectId}/credentials/${created.id}`, {
      method: "DELETE"
    });
    expect(revoke.status).toBe(204);
    expect(
      (
        await app.request("/api/public/traces?limit=1", {
          headers: { authorization: `Bearer ${created.token}` }
        })
      ).status
    ).toBe(401);

    const row = await pool.query<{ revoked_at: Date; revoked_by_username: string }>(
      "select revoked_at, revoked_by_username from machine_credentials where id = $1",
      [created.id]
    );
    expect(row.rows[0]?.revoked_at).toBeInstanceOf(Date);
    expect(row.rows[0]?.revoked_by_username).toBe("api-test-owner");
    const audit = await pool.query(
      `select id from auth_audit_events
        where event_type = 'machine_credential.revoked'
          and details->>'credentialId' = $1`,
      [created.id]
    );
    expect(audit.rowCount).toBe(1);
  });

  it("cannot revoke a credential belonging to another project", async () => {
    const createRes = await createCredential(otherProjectId, "ingest", "other project");
    const created = (await createRes.json()) as { id: string };
    const revoke = await ownerRequest(`/api/v1/projects/${projectId}/credentials/${created.id}`, {
      method: "DELETE"
    });
    expect(revoke.status).toBe(404);
    const row = await pool.query<{ revoked_at: Date | null }>(
      "select revoked_at from machine_credentials where id = $1",
      [created.id]
    );
    expect(row.rows[0]?.revoked_at).toBeNull();
  });
});
