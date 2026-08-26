import type { Pool } from "pg";
import { ulid } from "ulid";
import { hashOwnerSecret } from "../../src/lib/owner-secrets.js";

const TEST_OWNER_ORGANIZATION_ID = "org_api_integration_owner";
const OWNER_LOCK_ID = 6_407_064;

/**
 * Gives integration suites a real cookie-backed owner session while sharing
 * the schema's intentionally-singleton owner safely across parallel files.
 */
export async function createTestOwnerSession(pool: Pool): Promise<{
  organizationId: string;
  cookie: string;
}> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [OWNER_LOCK_ID]);
    let owner = await client.query<{ id: string; organization_id: string }>(
      "select id, organization_id from owner_principals limit 1"
    );
    if (!owner.rows[0]) {
      await client.query(
        `insert into organizations (id, name) values ($1, $2)
         on conflict (id) do nothing`,
        [TEST_OWNER_ORGANIZATION_ID, "API integration owner"]
      );
      await client.query(
        `insert into owner_principals
           (id, organization_id, username, username_normalized, password_hash)
         values ($1, $2, $3, $4, $5)`,
        ["owner_api_integration", TEST_OWNER_ORGANIZATION_ID, "api-test-owner", "api-test-owner", "test-only"]
      );
      owner = await client.query<{ id: string; organization_id: string }>(
        "select id, organization_id from owner_principals limit 1"
      );
    }
    const row = owner.rows[0];
    if (!row) throw new Error("failed to create test owner");
    const token = `ironside_session_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "0").slice(0, 43)}`;
    await client.query(
      `insert into owner_sessions
         (id, principal_id, token_hash, idle_expires_at, absolute_expires_at)
       values ($1, $2, $3, now() + interval '1 hour', now() + interval '2 hours')`,
      [`session_${ulid()}`, row.id, hashOwnerSecret(token)]
    );
    await client.query("commit");
    return { organizationId: row.organization_id, cookie: `ironside_session=${token}` };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function ownerHeaders(cookie: string, headers?: RequestInit["headers"]): Headers {
  const result = new Headers(headers);
  result.set("cookie", cookie);
  result.set("origin", "http://localhost:5174");
  result.set("sec-fetch-site", "same-origin");
  return result;
}
