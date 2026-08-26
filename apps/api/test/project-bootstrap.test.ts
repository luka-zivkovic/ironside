import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createProjectWithBootstrapCredential } from "../src/lib/project-bootstrap.js";

describe("createProjectWithBootstrapCredential", () => {
  it("rolls the project back when initial credential insertion fails", async () => {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql.trim().split(/\s+/, 1)[0]!.toLowerCase());
        if (sql.includes("insert into projects")) {
          return {
            rows: [{
              id: "proj_test",
              organization_id: "org_test",
              name: "test",
              created_at: new Date(0),
              rate_limit_per_minute: null,
              retention_days: null,
              trace_quiet_period_seconds: null
            }]
          };
        }
        if (sql.includes("insert into machine_credentials")) throw new Error("forced credential failure");
        return { rows: [] };
      }),
      release: vi.fn()
    } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(
      createProjectWithBootstrapCredential(pool, {
        organizationId: "org_test",
        name: "test",
        principalId: "owner_test",
        username: "test-owner"
      })
    ).rejects.toThrow("forced credential failure");
    expect(calls).toEqual(["begin", "insert", "insert", "insert", "rollback"]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
