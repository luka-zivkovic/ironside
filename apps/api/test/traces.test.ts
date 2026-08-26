import { createClickHouseClient, insertTraces, runMigrations as runChMigrations } from "@ironside/clickhouse";
import { runMigrations as runPgMigrations } from "@ironside/db";
import { createIngestQueue } from "@ironside/queue";
import type { Trace } from "@ironside/shared";
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
let otherProjectId: string;
let ownerCookie: string;

function trace(overrides: Partial<Trace> = {}): Trace {
  return {
    id: `trace_${ulid()}`,
    projectId,
    timestamp: new Date().toISOString(),
    tags: [],
    metadata: {},
    ...overrides
  };
}

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
    [projectId, orgId, "traces-test", otherProjectId, "traces-test-other"]
  );
  apiKey = (await createTestMachineCredential(pool, projectId, "traces-test", "integration")).token;
});

afterAll(async () => {
  await pool.query("delete from projects where id = any($1)", [[projectId, otherProjectId]]);
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

async function get(path: string) {
  return app.request(path.replace("/api/v1/traces", `/api/v1/projects/${projectId}/traces`), {
    headers: ownerHeaders(ownerCookie)
  });
}

describe("GET /api/v1/traces", () => {
  it("rejects requests without a valid API key", async () => {
    const res = await app.request(`/api/v1/projects/${projectId}/traces`);
    expect(res.status).toBe(401);
  });

  it("only returns traces for the authenticated project", async () => {
    const mine = trace({ name: "mine" });
    const theirs = trace({ id: `trace_${ulid()}`, projectId: otherProjectId, name: "theirs" });
    await insertTraces(clickhouse, [mine, theirs], { eventTs: new Date().toISOString() });

    const res = await get("/api/v1/traces?limit=100");
    const body = (await res.json()) as { traces: { id: string }[] };
    const ids = body.traces.map((t) => t.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  it("filters by userId, sessionId, and tags", async () => {
    const target = trace({
      userId: "user_42",
      sessionId: "sess_1",
      tags: ["prod", "checkout"]
    });
    const other = trace({ userId: "user_other" });
    await insertTraces(clickhouse, [target, other], { eventTs: new Date().toISOString() });

    const byUser = await get(`/api/v1/traces?userId=user_42&limit=100`);
    const byUserIds = ((await byUser.json()) as { traces: { id: string }[] }).traces.map(
      (t) => t.id
    );
    expect(byUserIds).toContain(target.id);
    expect(byUserIds).not.toContain(other.id);

    const byTags = await get(`/api/v1/traces?tags=prod&tags=checkout&limit=100`);
    const byTagIds = ((await byTags.json()) as { traces: { id: string }[] }).traces.map(
      (t) => t.id
    );
    expect(byTagIds).toContain(target.id);

    const byWrongTag = await get(`/api/v1/traces?tags=staging&limit=100`);
    const byWrongTagIds = ((await byWrongTag.json()) as { traces: { id: string }[] }).traces.map(
      (t) => t.id
    );
    expect(byWrongTagIds).not.toContain(target.id);
  });

  it("returns environment summaries and keeps list/aggregate filtering aligned and project-scoped", async () => {
    const marker = `environment_${ulid()}`;
    const production = trace({ environment: "production", tags: [marker] });
    const staging = trace({ environment: "staging", tags: [marker] });
    const foreign = trace({
      id: `trace_${ulid()}`,
      projectId: otherProjectId,
      environment: "production",
      tags: [marker]
    });
    await insertTraces(clickhouse, [production, staging, foreign], {
      eventTs: new Date().toISOString()
    });

    const list = await get(
      `/api/v1/traces?tags=${marker}&environment=production&limit=100`
    );
    const listBody = (await list.json()) as {
      traces: { id: string; environment: string | null }[];
    };
    expect(listBody.traces).toEqual([
      expect.objectContaining({ id: production.id, environment: "production" })
    ]);

    const aggregates = await get(
      `/api/v1/traces/aggregates?tags=${marker}&environment=production`
    );
    expect(((await aggregates.json()) as { traceCount: number }).traceCount).toBe(
      listBody.traces.length
    );

    const invalid = await get(`/api/v1/traces?environment=${"x".repeat(65)}`);
    expect(invalid.status).toBe(400);
  });

  it("filters by metadata key/value", async () => {
    const match = trace({ metadata: { plan: "enterprise" } });
    const noMatch = trace({ metadata: { plan: "free" } });
    await insertTraces(clickhouse, [match, noMatch], { eventTs: new Date().toISOString() });

    const res = await get(`/api/v1/traces?metadataKey=plan&metadataValue=enterprise&limit=100`);
    const ids = ((await res.json()) as { traces: { id: string }[] }).traces.map((t) => t.id);
    expect(ids).toContain(match.id);
    expect(ids).not.toContain(noMatch.id);
  });

  it("paginates with a stable keyset cursor across pages, newest first, no duplicates or gaps", async () => {
    const base = Date.now();
    const seeded: Trace[] = Array.from({ length: 5 }, (_, i) =>
      trace({
        id: `trace_page_${ulid()}`,
        timestamp: new Date(base + i * 1000).toISOString(),
        name: `page-${i}`
      })
    );
    await insertTraces(clickhouse, seeded, { eventTs: new Date().toISOString() });
    const expectedIds = [...seeded].reverse().map((t) => t.id); // newest first

    // Walk the full unfiltered list page by page (earlier tests in this file
    // insert other traces into the same project) and pick out the seeded
    // batch by id, checking it comes back complete, in order, no duplicates.
    const seenIds: string[] = [];
    let nextCursor: string | null = null;
    let guard = 0;
    do {
      const path: string = nextCursor
        ? `/api/v1/traces?limit=2&cursor=${encodeURIComponent(nextCursor)}`
        : `/api/v1/traces?limit=2`;
      const res = await get(path);
      const body = (await res.json()) as {
        traces: { id: string }[];
        nextCursor: string | null;
      };
      for (const t of body.traces) {
        if (expectedIds.includes(t.id)) seenIds.push(t.id);
      }
      nextCursor = body.nextCursor;
      guard += 1;
    } while (nextCursor && guard < 50);

    expect(seenIds).toEqual(expectedIds);
  });

  it("rejects a malformed cursor with 400 instead of a ClickHouse error", async () => {
    const res = await get("/api/v1/traces?cursor=not-a-real-cursor");
    expect(res.status).toBe(400);
  });
});
