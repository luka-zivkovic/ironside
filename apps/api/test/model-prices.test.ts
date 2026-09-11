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
import { createTestOwnerSession, ownerHeaders } from "./helpers/owner-session.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

const app = createApp({ pgPool: pool, clickhouse, redis, storage, queue, webOrigins: ["http://localhost:5174"], defaultRateLimitPerMinute: 10000 });

let projectId: string;
let otherOrgProjectId: string;
let ownerCookie: string;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  const owner = await createTestOwnerSession(pool);
  ownerCookie = owner.cookie;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
    projectId,
    owner.organizationId,
    "model-prices-test"
  ]);
  const otherOrgId = `org_${ulid()}`;
  otherOrgProjectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [otherOrgId, "model-prices-other-org"]);
  await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
    otherOrgProjectId,
    otherOrgId,
    "model-prices-other"
  ]);
});

afterAll(async () => {
  await pool.query("delete from projects where id = any($1)", [[projectId, otherOrgProjectId]]);
  await pool.query("delete from organizations where name = 'model-prices-other-org'");
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

function authed(path: string, init?: RequestInit) {
  return app.request(path, { ...init, headers: ownerHeaders(ownerCookie, init?.headers) });
}

describe("/api/v1/projects/:id/model-prices", () => {
  it("starts empty and reports the vendored table", async () => {
    const res = await authed(`/api/v1/projects/${projectId}/model-prices`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { overrides: unknown[]; table: { syncedAt: string; modelCount: number } };
    expect(body.overrides).toEqual([]);
    expect(body.table.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.table.modelCount).toBeGreaterThan(1000);
  });

  it("replaces the ordered override list and round-trips prices", async () => {
    const put = await authed(`/api/v1/projects/${projectId}/model-prices`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        overrides: [
          { pattern: "^my-finetune-", inputCostPerToken: 0.000002, outputCostPerToken: 0.000008 },
          { pattern: "embed", inputCostPerToken: 0.00000002 }
        ]
      })
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { overrides: { id: string; pattern: string; inputCostPerToken: number | null; outputCostPerToken: number | null; cacheReadInputTokenCost: number | null }[] };
    expect(body.overrides.map((o) => o.pattern)).toEqual(["^my-finetune-", "embed"]);
    expect(body.overrides[0]).toMatchObject({ inputCostPerToken: 0.000002, outputCostPerToken: 0.000008, cacheReadInputTokenCost: null });
    expect(body.overrides[1]).toMatchObject({ inputCostPerToken: 0.00000002, outputCostPerToken: null });
    expect(body.overrides.every((o) => o.id.startsWith("mprice_"))).toBe(true);

    const get = await authed(`/api/v1/projects/${projectId}/model-prices`);
    expect(((await get.json()) as { overrides: { pattern: string }[] }).overrides.map((o) => o.pattern)).toEqual([
      "^my-finetune-",
      "embed"
    ]);

    const cleared = await authed(`/api/v1/projects/${projectId}/model-prices`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overrides: [] })
    });
    expect(((await cleared.json()) as { overrides: unknown[] }).overrides).toEqual([]);
  });

  it("rejects invalid regular expressions, negative prices and price-less rules", async () => {
    for (const override of [
      { pattern: "(", inputCostPerToken: 0.000001 },
      { pattern: "ok", inputCostPerToken: -1 },
      { pattern: "ok" }
    ]) {
      const res = await authed(`/api/v1/projects/${projectId}/model-prices`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ overrides: [override] })
      });
      expect(res.status, JSON.stringify(override)).toBe(400);
    }
  });

  it("is project-scoped to the owner's organization and needs an owner session", async () => {
    const foreign = await authed(`/api/v1/projects/${otherOrgProjectId}/model-prices`);
    expect(foreign.status).toBe(404);
    const anonymous = await app.request(`/api/v1/projects/${projectId}/model-prices`);
    expect(anonymous.status).toBe(401);
  });
});
