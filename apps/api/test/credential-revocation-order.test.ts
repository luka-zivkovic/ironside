import type { Redis } from "ioredis";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { revokeMachineCredential } from "../src/lib/machine-credentials.js";

function scopedRevocationRow() {
  return {
    id: "cred_test",
    project_id: "proj_test",
    name: "test",
    token_hash: "a".repeat(64),
    token_prefix: "ironside_sc_abcd",
    preset: "ingest",
    capabilities: ["ingest", "media:write"],
    expires_at: null
  };
}

function mockPool(events: string[]) {
  const client = {
    query: vi.fn(async (sql: string) => {
      const operation = sql.trim().split(/\s+/, 1)[0]!.toLowerCase();
      events.push(operation);
      if (sql.includes("update machine_credentials")) return { rows: [scopedRevocationRow()] };
      return { rows: [] };
    }),
    release: vi.fn()
  } as unknown as PoolClient;
  return { pool: { connect: vi.fn(async () => client) } as unknown as Pool, client };
}

const input = {
  projectId: "proj_test",
  organizationId: "org_test",
  credentialId: "cred_test",
  actor: { principalId: "owner_test", username: "owner" }
};

describe("credential revocation ordering", () => {
  it("writes the cache sentinel before committing Postgres", async () => {
    const events: string[] = [];
    const { pool } = mockPool(events);
    const redis = {
      set: vi.fn(async () => {
        events.push("sentinel");
        return "OK";
      })
    } as unknown as Redis;

    await expect(revokeMachineCredential(pool, redis, input)).resolves.toBe(true);
    expect(events.indexOf("sentinel")).toBeLessThan(events.indexOf("commit"));
  });

  it("rolls back the credential and audit mutation when the sentinel cannot be persisted", async () => {
    const events: string[] = [];
    const { pool, client } = mockPool(events);
    const redis = {
      set: vi.fn(async () => {
        throw new Error("redis unavailable");
      })
    } as unknown as Redis;

    await expect(revokeMachineCredential(pool, redis, input)).rejects.toThrow("redis unavailable");
    expect(events).toContain("rollback");
    expect(events).not.toContain("commit");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
