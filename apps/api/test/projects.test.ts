import {
  observeProjectEnvironments,
  runMigrations as runPgMigrations
} from "@ironside/db";
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

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

const app = createApp({ pgPool: pool, clickhouse, redis, storage, queue, webOrigins: ["http://localhost:5174"], defaultRateLimitPerMinute: 10000 });

let apiKey: string;
let projectId: string;
let siblingProjectId: string;
let otherOrgApiKey: string;
let otherOrgProjectId: string;
let ownerCookie: string;
let createdProjectId: string | null = null;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();

  const owner = await createTestOwnerSession(pool);
  const orgId = owner.organizationId;
  ownerCookie = owner.cookie;
  projectId = `proj_${ulid()}`;
  siblingProjectId = `proj_${ulid()}`;
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3), ($4, $2, $5)",
    [projectId, orgId, "projects-test-main", siblingProjectId, "projects-test-sibling"]
  );
  apiKey = (await createTestMachineCredential(pool, projectId, "projects-test", "ingest")).token;

  const otherOrgId = `org_${ulid()}`;
  otherOrgProjectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [otherOrgId, "projects-test-other-org"]);
  await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
    otherOrgProjectId,
    otherOrgId,
    "projects-test-other-org-project"
  ]);
  otherOrgApiKey = (await createTestMachineCredential(pool, otherOrgProjectId, "other-org", "ingest")).token;
});

afterAll(async () => {
  await pool.query("delete from projects where id = any($1)", [[projectId, siblingProjectId, ...(createdProjectId ? [createdProjectId] : [])]]);
  await pool.query("delete from organizations where name = 'projects-test-other-org'");
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

function authed(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: ownerHeaders(ownerCookie, init?.headers)
  });
}

describe("GET /api/v1/projects", () => {
  it("rejects requests without a valid owner session", async () => {
    const res = await app.request("/api/v1/projects");
    expect(res.status).toBe(401);
  });

  it("lists every project in the caller's organization, including the caller's own", async () => {
    const res = await authed("/api/v1/projects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: { id: string }[] };
    const ids = body.projects.map((p) => p.id);
    expect(ids).toContain(projectId);
    expect(ids).toContain(siblingProjectId);
  });

  it("does not leak projects from a different organization", async () => {
    const res = await authed("/api/v1/projects");
    const body = (await res.json()) as { projects: { name: string }[] };
    const names = body.projects.map((p) => p.name);
    expect(names).not.toContain("projects-test-other-org-project");
  });

  it("returns the same non-enumerating denial for foreign and nonexistent project ids", async () => {
    const foreign = await authed(`/api/v1/projects/${otherOrgProjectId}/traces`);
    const missing = await authed("/api/v1/projects/proj_doesnotexist/traces");
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
  });

  it.each([
    ["GET", () => `/api/v1/projects/${projectId}/credentials`, undefined],
    ["POST", () => `/api/v1/projects/${projectId}/credentials`, { name: "forbidden", preset: "ingest" }],
    ["GET", () => `/api/v1/projects/${projectId}/exports`, undefined],
    ["GET", () => `/api/v1/projects/${projectId}/otlp-forwards`, undefined],
    ["GET", () => `/api/v1/projects/${projectId}/webhooks`, undefined],
    ["GET", () => `/api/v1/projects/${projectId}/import-sources`, undefined],
    ["GET", () => `/api/v1/projects/${projectId}/ingest-failures`, undefined],
    ["GET", () => `/api/v1/projects/${projectId}/environments`, undefined],
    [
      "PATCH",
      () => `/api/v1/projects/${projectId}/environments/visibility`,
      { environment: "production", hidden: true }
    ]
  ])("rejects machine keys on session route %s", async (method, path, body) => {
    const res = await app.request(path(), {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body ? { "content-type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    expect(res.status).toBe(401);
  });

  it("leaves removed flat browser and management routes absent", async () => {
    for (const path of ["/api/v1/traces", "/api/v1/credentials", "/api/v1/exports", "/api/v1/ingest-failures"]) {
      const res = await app.request(path, { headers: { authorization: `Bearer ${apiKey}` } });
      expect(res.status).toBe(404);
    }
  });

  it("rejects cross-site owner-session mutations", async () => {
    const res = await app.request(`/api/v1/projects/${projectId}/quotas`, {
      method: "PATCH",
      headers: {
        cookie: ownerCookie,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json"
      },
      body: JSON.stringify({ rateLimitPerMinute: 1 })
    });
    expect(res.status).toBe(403);
  });
});

describe("project environment discovery", () => {
  it("lists observed values and only toggles visibility for an existing project value", async () => {
    await observeProjectEnvironments(pool, projectId, [
      { environment: "production", traceTimestamp: "2026-08-25T00:00:00.000Z" }
    ]);
    const list = await authed(`/api/v1/projects/${projectId}/environments`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      environments: [expect.objectContaining({ name: "production", hidden: false })],
      limit: 100,
      overflowed: false
    });

    const hidden = await authed(
      `/api/v1/projects/${projectId}/environments/visibility`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environment: " production ", hidden: true })
      }
    );
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toMatchObject({ name: "production", hidden: true });

    const unknown = await authed(
      `/api/v1/projects/${projectId}/environments/visibility`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environment: "manual-value", hidden: true })
      }
    );
    expect(unknown.status).toBe(404);
    const rows = await pool.query(
      "select 1 from project_environments where project_id = $1 and name = 'manual-value'",
      [projectId]
    );
    expect(rows.rowCount).toBe(0);
  });
});

describe("POST /api/v1/projects", () => {
  it("creates a new project in the caller's organization", async () => {
    const res = await authed("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "new-project" })
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const created = (await res.json()) as {
      project: { id: string; organizationId: string; name: string };
      initialCredential: { token: string; preset: string; capabilities: string[] };
    };
    createdProjectId = created.project.id;
    expect(created.project.name).toBe("new-project");
    expect(created.initialCredential).toMatchObject({ preset: "ingest", capabilities: ["ingest", "media:write"] });
    expect(created.initialCredential.token).toMatch(/^ironside_sc_[0-9a-f]{64}$/);

    const list = await authed("/api/v1/projects");
    const body = (await list.json()) as { projects: { id: string }[] };
    expect(body.projects.map((p) => p.id)).toContain(created.project.id);
  });

  it("rejects an empty name", async () => {
    const res = await authed("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" })
    });
    expect(res.status).toBe(400);
  });

  it("a machine key cannot list or create projects", async () => {
    const res = await app.request("/api/v1/projects", {
      headers: { authorization: `Bearer ${otherOrgApiKey}` }
    });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/v1/projects/:id/quotas", () => {
  it("sets an override, and an omitted field in a later request leaves it unchanged", async () => {
    const first = await authed(`/api/v1/projects/${siblingProjectId}/quotas`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rateLimitPerMinute: 500,
        retentionDays: 30,
        traceQuietPeriodSeconds: 90
      })
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      rateLimitPerMinute: number | null;
      retentionDays: number | null;
      traceQuietPeriodSeconds: number | null;
    };
    expect(firstBody.rateLimitPerMinute).toBe(500);
    expect(firstBody.retentionDays).toBe(30);
    expect(firstBody.traceQuietPeriodSeconds).toBe(90);

    // Omitting retentionDays entirely must leave it at 30, not clear it.
    const second = await authed(`/api/v1/projects/${siblingProjectId}/quotas`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rateLimitPerMinute: 900 })
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      rateLimitPerMinute: number | null;
      retentionDays: number | null;
      traceQuietPeriodSeconds: number | null;
    };
    expect(secondBody.rateLimitPerMinute).toBe(900);
    expect(secondBody.retentionDays).toBe(30); // unchanged
    expect(secondBody.traceQuietPeriodSeconds).toBe(90); // unchanged
  });

  it("an explicit null clears an override back to the platform default", async () => {
    await authed(`/api/v1/projects/${siblingProjectId}/quotas`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rateLimitPerMinute: 500 })
    });

    const cleared = await authed(`/api/v1/projects/${siblingProjectId}/quotas`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rateLimitPerMinute: null })
    });
    expect(cleared.status).toBe(200);
    const body = (await cleared.json()) as { rateLimitPerMinute: number | null };
    expect(body.rateLimitPerMinute).toBeNull();
  });

  it("cannot change quotas for a project in a different organization", async () => {
    const res = await authed(`/api/v1/projects/${otherOrgProjectId}/quotas`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rateLimitPerMinute: 1 })
    });
    expect(res.status).toBe(404);

    // The attempted cross-org PATCH must not have taken effect.
    const target = await pool.query<{ rate_limit_per_minute: number | null }>(
      "select rate_limit_per_minute from projects where id = $1",
      [otherOrgProjectId]
    );
    expect(target.rows[0]?.rate_limit_per_minute).not.toBe(1);
  });

  it("returns 404 for a nonexistent project id", async () => {
    const res = await authed("/api/v1/projects/proj_doesnotexist/quotas", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rateLimitPerMinute: 1 })
    });
    expect(res.status).toBe(404);
  });
});
