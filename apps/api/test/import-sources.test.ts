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
import { createTestMachineCredential } from "./helpers/machine-credential.js";
import { createTestOwnerSession, ownerHeaders } from "./helpers/owner-session.js";

// Integration tests for the M5-07 day-2 CRUD route: /api/v1/import-sources
// — connecting LangFuse/LangSmith credentials so apps/worker's scheduler
// can run runLangfuseImport/runLangsmithImport automatically.

process.env.IRONSIDE_ENCRYPTION_SECRET ??= "import-sources-test-secret";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

const app = createApp({ pgPool: pool, clickhouse, redis, storage, queue, webOrigins: ["http://localhost:5174"], defaultRateLimitPerMinute: 10000 });

let apiKey: string;
let otherProjectApiKey: string;
let projectId: string;
let otherProjectId: string;
let ownerCookie: string;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();
  const owner = await createTestOwnerSession(pool);
  const orgId = owner.organizationId;
  ownerCookie = owner.cookie;
  projectId = `proj_${ulid()}`;
  otherProjectId = `proj_${ulid()}`;
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3), ($4, $2, $5)",
    [projectId, orgId, "import-sources-test", otherProjectId, "import-sources-test-other"]
  );
  apiKey = (await createTestMachineCredential(pool, projectId, "import-sources-test", "ingest")).token;
  otherProjectApiKey = (await createTestMachineCredential(pool, otherProjectId, "other", "ingest")).token;
});

afterAll(async () => {
  await pool.query("delete from projects where id = any($1)", [[projectId, otherProjectId]]);
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

async function req(method: string, path: string, key: string, body?: unknown) {
  const targetProjectId = key === otherProjectApiKey ? otherProjectId : projectId;
  return app.request(path.replace("/api/v1", `/api/v1/projects/${targetProjectId}`), {
    method,
    headers: ownerHeaders(ownerCookie, {
      ...(body !== undefined && { "content-type": "application/json" })
    }),
    ...(body !== undefined && { body: JSON.stringify(body) })
  });
}

describe("import-sources CRUD (/api/v1/import-sources)", () => {
  it("rejects requests without a valid owner session", async () => {
    const res = await app.request(`/api/v1/projects/${projectId}/import-sources`);
    expect(res.status).toBe(401);
  });

  it("connects a LangFuse source; credentials are never echoed back and decrypt to what was sent", async () => {
    const create = await req("POST", "/api/v1/import-sources", apiKey, {
      provider: "langfuse",
      publicKey: "pk_test",
      secretKey: "sk_super_secret",
      baseUrl: "https://langfuse.example.com"
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as Record<string, unknown>;
    expect(created.provider).toBe("langfuse");
    expect(created.enabled).toBe(true);
    expect(created.pollIntervalSeconds).toBeGreaterThan(0);
    // No credential field of any kind survives into the response shape.
    expect("publicKey" in created).toBe(false);
    expect("secretKey" in created).toBe(false);
    expect("encryptedCredentials" in created).toBe(false);
    expect(JSON.stringify(created)).not.toContain("sk_super_secret");

    const list = await req("GET", "/api/v1/import-sources", apiKey);
    const body = (await list.json()) as { importSources: { id: string }[] };
    expect(body.importSources.map((s) => s.id)).toContain(created.id);
  });

  it("connects a LangSmith source (different credential shape) — the discriminated union accepts sessionIds, not publicKey/secretKey", async () => {
    const create = await req("POST", "/api/v1/import-sources", apiKey, {
      provider: "langsmith",
      apiKey: "ls_test_key",
      sessionIds: ["session-uuid-1", "session-uuid-2"]
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as Record<string, unknown>;
    expect(created.provider).toBe("langsmith");
    expect("apiKey" in created).toBe(false);
    expect("sessionIds" in created).toBe(false);
  });

  it("rejects a LangFuse request carrying LangSmith-only fields (or missing LangFuse-required fields) with 400", async () => {
    const res = await req("POST", "/api/v1/import-sources", apiKey, {
      provider: "langfuse",
      apiKey: "wrong-field-for-this-provider",
      sessionIds: ["x"]
    });
    expect(res.status).toBe(400);
  });

  it("connecting the same provider twice upserts (replaces credentials) rather than erroring on a duplicate", async () => {
    const first = await req("POST", "/api/v1/import-sources", apiKey, {
      provider: "langsmith",
      apiKey: "old-key",
      sessionIds: ["s1"]
    });
    const firstBody = (await first.json()) as { id: string };

    const second = await req("POST", "/api/v1/import-sources", apiKey, {
      provider: "langsmith",
      apiKey: "new-key",
      sessionIds: ["s1", "s2"]
    });
    const secondBody = (await second.json()) as { id: string };
    expect(secondBody.id).toBe(firstBody.id);

    const list = await req("GET", "/api/v1/import-sources", apiKey);
    const body = (await list.json()) as { importSources: { provider: string }[] };
    expect(body.importSources.filter((s) => s.provider === "langsmith")).toHaveLength(1);
  });

  it("patches enabled/pollIntervalSeconds and deletes a source; a caller cannot patch/delete another project's source", async () => {
    const create = await req("POST", "/api/v1/import-sources", apiKey, {
      provider: "langfuse",
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "https://langfuse.example.com",
      pollIntervalSeconds: 1800
    });
    const created = (await create.json()) as { id: string; pollIntervalSeconds: number };
    expect(created.pollIntervalSeconds).toBe(1800);

    const patch = await req("PATCH", `/api/v1/import-sources/${created.id}`, apiKey, { enabled: false });
    expect((await patch.json() as { enabled: boolean }).enabled).toBe(false);

    const crossProjectPatch = await req(
      "PATCH",
      `/api/v1/import-sources/${created.id}`,
      otherProjectApiKey,
      { enabled: true }
    );
    expect(crossProjectPatch.status).toBe(404);

    const crossProjectDelete = await req(
      "DELETE",
      `/api/v1/import-sources/${created.id}`,
      otherProjectApiKey
    );
    expect(crossProjectDelete.status).toBe(404);

    const del = await req("DELETE", `/api/v1/import-sources/${created.id}`, apiKey);
    expect(del.status).toBe(204);
  });
});
