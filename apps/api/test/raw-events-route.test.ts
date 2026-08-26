import {
  createClickHouseClient,
  insertObservations,
  insertRawEventRefs,
  insertTraces,
  runMigrations as runChMigrations,
  recordTraceRawRetentionExpired
} from "@ironside/clickhouse";
import { runMigrations as runPgMigrations } from "@ironside/db";
import { createIngestQueue } from "@ironside/queue";
import type { IngestBatch, Observation, Trace } from "@ironside/shared";
import { rawObjectKey } from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestMachineCredential } from "./helpers/machine-credential.js";
import { createTestOwnerSession, ownerHeaders } from "./helpers/owner-session.js";

// Integration coverage for GET /api/v1/traces/:id/raw-events against the
// real stack (durable ClickHouse raw-object index + MinIO). Pure
// filtering/cap logic lives in raw-events.test.ts.

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

const app = createApp({ pgPool: pool, clickhouse, redis, storage, queue, webOrigins: ["http://localhost:5174"], defaultRateLimitPerMinute: 10000 });

let apiKey: string;
let projectId: string;
let ownerCookie: string;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();
  const owner = await createTestOwnerSession(pool);
  const orgId = owner.organizationId;
  ownerCookie = owner.cookie;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
    projectId,
    orgId,
    "raw-events-test"
  ]);
  apiKey = (await createTestMachineCredential(pool, projectId, "raw-events-test", "integration")).token;
});

afterAll(async () => {
  await pool.query("delete from projects where id = $1", [projectId]);
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

async function indexRawObjects(
  traceId: string,
  refs: { objectKey: string; receivedAt: string }[]
): Promise<void> {
  for (const ref of refs) {
    await insertRawEventRefs(
      clickhouse,
      [{ projectId, traceId, objectKey: ref.objectKey, receivedAt: ref.receivedAt }],
      ref.receivedAt
    );
  }
}

describe("GET /api/v1/traces/:id/raw-events", () => {
  it("returns 404 for a trace that does not exist", async () => {
    const res = await get(`/api/v1/traces/does_not_exist/raw-events`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "trace not found" });
  });

  it("returns the trace's raw envelope events from the stored batch", async () => {
    const traceId = `trace_${ulid()}`;
    const otherTraceId = `trace_${ulid()}`;
    const receivedAt = new Date();
    const eventTs = receivedAt.toISOString();

    const trace: Trace = {
      id: traceId,
      projectId,
      timestamp: eventTs,
      tags: [],
      metadata: {}
    };
    await insertTraces(clickhouse, [trace], { eventTs });

    const batchId = ulid();
    const batch: IngestBatch = {
      batchId,
      projectId,
      receivedAt: eventTs,
      events: [
        {
          id: `evt_${ulid()}`,
          type: "trace-upsert",
          source: "native",
          schemaVersion: 1,
          idempotencyKey: "ik_trace",
          body: { id: traceId, timestamp: eventTs, tags: [], metadata: {} }
        },
        {
          id: `evt_${ulid()}`,
          type: "observation-upsert",
          source: "native",
          schemaVersion: 1,
          idempotencyKey: "ik_obs",
          body: { id: `obs_${ulid()}`, traceId, type: "span", startTime: eventTs }
        },
        {
          id: `evt_${ulid()}`,
          type: "observation-upsert",
          source: "native",
          schemaVersion: 1,
          idempotencyKey: "ik_other",
          body: { id: `obs_${ulid()}`, traceId: otherTraceId, type: "span", startTime: eventTs }
        }
      ]
    };
    const objectKey = rawObjectKey(projectId, receivedAt, batchId);
    await storage.putJson(objectKey, batch);
    await indexRawObjects(traceId, [{ objectKey, receivedAt: eventTs }]);

    const res = await get(`/api/v1/traces/${traceId}/raw-events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      traceId: string;
      events: { batchId: string; objectKey: string; event: { type: string }; containingBatch: boolean }[];
      scannedObjects: number;
      truncated: boolean;
    };

    expect(body.traceId).toBe(traceId);
    // The other trace's observation event is filtered out.
    expect(body.events).toHaveLength(2);
    expect(body.events.map((e) => e.event.type).sort()).toEqual([
      "observation-upsert",
      "trace-upsert"
    ]);
    expect(body.events.every((e) => e.batchId === batchId && e.objectKey === objectKey)).toBe(true);
    expect(body.events.every((e) => e.containingBatch === false)).toBe(true);
    expect(body.scannedObjects).toBeGreaterThanOrEqual(1);
    expect(body.truncated).toBe(false);
  });

  it("finds raw batches across days when the trace was touched on more than one day", async () => {
    const traceId = `trace_${ulid()}`;
    const DAY_MS = 24 * 60 * 60 * 1000;
    // Trace-upsert batch five days ago; an observation batch two days ago.
    // The observation batch never touches the traces row, so the durable
    // index must associate both exact raw objects with the same trace.
    const traceDay = new Date(Date.now() - 5 * DAY_MS);
    const obsDay = new Date(Date.now() - 2 * DAY_MS);

    const trace: Trace = {
      id: traceId,
      projectId,
      timestamp: traceDay.toISOString(),
      tags: [],
      metadata: {}
    };
    await insertTraces(clickhouse, [trace], { eventTs: traceDay.toISOString() });
    const traceBatchId = ulid();
    const traceBatch: IngestBatch = {
      batchId: traceBatchId,
      projectId,
      receivedAt: traceDay.toISOString(),
      events: [
        {
          id: `evt_${ulid()}`,
          type: "trace-upsert",
          source: "native",
          schemaVersion: 1,
          idempotencyKey: "ik_trace_day1",
          body: { id: traceId, timestamp: traceDay.toISOString(), tags: [], metadata: {} }
        }
      ]
    };
    const traceObjectKey = rawObjectKey(projectId, traceDay, traceBatchId);
    await storage.putJson(traceObjectKey, traceBatch);

    const observation: Observation = {
      id: `obs_${ulid()}`,
      traceId,
      projectId,
      type: "span",
      startTime: obsDay.toISOString(),
      level: "default",
      metadata: {}
    };
    await insertObservations(clickhouse, [observation], { eventTs: obsDay.toISOString() });
    const obsBatchId = ulid();
    const obsBatch: IngestBatch = {
      batchId: obsBatchId,
      projectId,
      receivedAt: obsDay.toISOString(),
      events: [
        {
          id: `evt_${ulid()}`,
          type: "observation-upsert",
          source: "native",
          schemaVersion: 1,
          idempotencyKey: "ik_obs_day3",
          body: { id: observation.id, traceId, type: "span", startTime: obsDay.toISOString() }
        }
      ]
    };
    const obsObjectKey = rawObjectKey(projectId, obsDay, obsBatchId);
    await storage.putJson(obsObjectKey, obsBatch);
    await indexRawObjects(traceId, [
      { objectKey: traceObjectKey, receivedAt: traceDay.toISOString() },
      { objectKey: obsObjectKey, receivedAt: obsDay.toISOString() }
    ]);

    const res = await get(`/api/v1/traces/${traceId}/raw-events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { batchId: string; event: { type: string } }[];
      truncated: boolean;
    };
    expect(body.events.map((e) => e.batchId).sort()).toEqual([traceBatchId, obsBatchId].sort());
    expect(body.truncated).toBe(false);
  });

  it("keeps trace-upsert-only history complete after older trace versions have been merged away", async () => {
    const traceId = `trace_${ulid()}`;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const firstDay = new Date(Date.now() - 6 * DAY_MS);
    const latestDay = new Date(Date.now() - 2 * DAY_MS);
    const traceTimestamp = firstDay.toISOString();

    // This is the observable state after ReplacingMergeTree has merged the
    // older version: only the latest trace row remains. The old implementation
    // derived its S3 window from row history and could no longer discover the
    // first raw object. The durable refs must recover both without that row.
    const latestTrace: Trace = {
      id: traceId,
      projectId,
      timestamp: traceTimestamp,
      name: "latest-version",
      tags: [],
      metadata: {}
    };
    await insertTraces(clickhouse, [latestTrace], { eventTs: latestDay.toISOString() });

    const refs: { objectKey: string; receivedAt: string }[] = [];
    const batchIds: string[] = [];
    for (const [receivedAt, name] of [
      [firstDay, "first-version"],
      [latestDay, "latest-version"]
    ] as const) {
      const batchId = ulid();
      batchIds.push(batchId);
      const batch: IngestBatch = {
        batchId,
        projectId,
        receivedAt: receivedAt.toISOString(),
        events: [
          {
            id: `evt_${ulid()}`,
            type: "trace-upsert",
            source: "native",
            schemaVersion: 1,
            idempotencyKey: `ik_${name}`,
            body: { id: traceId, timestamp: traceTimestamp, name, tags: [], metadata: {} }
          }
        ]
      };
      const objectKey = rawObjectKey(projectId, receivedAt, batchId);
      await storage.putJson(objectKey, batch);
      refs.push({ objectKey, receivedAt: receivedAt.toISOString() });
    }
    await indexRawObjects(traceId, refs);

    const res = await get(`/api/v1/traces/${traceId}/raw-events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { batchId: string }[];
      truncated: boolean;
    };
    expect(body.events.map((event) => event.batchId).sort()).toEqual(batchIds.sort());
    expect(body.truncated).toBe(false);
  });

  it("reports a transient pending ref without claiming completeness", async () => {
    const traceId = `trace_${ulid()}`;
    const receivedAt = new Date();
    const eventTs = receivedAt.toISOString();
    await insertTraces(
      clickhouse,
      [{ id: traceId, projectId, timestamp: eventTs, tags: [], metadata: {} }],
      { eventTs }
    );

    const appliedBatchId = ulid();
    const appliedObjectKey = rawObjectKey(projectId, receivedAt, appliedBatchId);
    await storage.putJson(appliedObjectKey, {
      batchId: appliedBatchId,
      projectId,
      receivedAt: eventTs,
      events: [
        {
          id: `evt_${ulid()}`,
          type: "trace-upsert",
          source: "native",
          schemaVersion: 1,
          idempotencyKey: "ik_applied",
          body: { id: traceId, timestamp: eventTs, tags: [], metadata: {} }
        }
      ]
    } satisfies IngestBatch);
    await indexRawObjects(traceId, [{ objectKey: appliedObjectKey, receivedAt: eventTs }]);

    const pendingAt = new Date(receivedAt.getTime() + 1_000).toISOString();
    const pendingObjectKey = rawObjectKey(projectId, new Date(pendingAt), ulid());
    await insertRawEventRefs(
      clickhouse,
      [{ projectId, traceId, objectKey: pendingObjectKey, receivedAt: pendingAt }],
      pendingAt,
      false
    );

    const res = await get(`/api/v1/traces/${traceId}/raw-events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { batchId: string }[];
      truncated: boolean;
      truncationReason: string;
    };
    expect(body.events.map((event) => event.batchId)).toEqual([appliedBatchId]);
    expect(body.truncated).toBe(true);
    expect(body.truncationReason).toBe("raw_index_pending");
  });

  it("returns honest empty history after retention removes the final visible trace and raw ref", async () => {
    const traceId = `trace_${ulid()}`;
    const expiredAt = new Date().toISOString();
    // This is the executor's terminal state: query-visible domain rows and
    // raw refs are gone, while the sticky retention marker remains.
    await recordTraceRawRetentionExpired(clickhouse, [
      { projectId, traceId, expiredAt }
    ]);

    const res = await get(`/api/v1/traces/${traceId}/raw-events`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      traceId,
      events: [],
      truncated: true,
      retentionExpired: true,
      truncationReason: "retention_expired"
    });
  });

  it("returns the explanatory 404 for an imported trace without scanning", async () => {
    const traceId = `trace_${ulid()}`;
    const eventTs = new Date().toISOString();
    const imported: Trace = {
      id: traceId,
      projectId,
      timestamp: eventTs,
      tags: ["imported:langfuse"],
      metadata: {}
    };
    await insertTraces(clickhouse, [imported], { eventTs });

    const res = await get(`/api/v1/traces/${traceId}/raw-events`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "no_raw_log",
      reason: "trace was imported; importers do not write the raw event log"
    });
  });

  it("does not let an importer-tagged trace reuse hide a sticky retention marker", async () => {
    const traceId = `trace_${ulid()}`;
    const eventTs = new Date().toISOString();
    await insertTraces(
      clickhouse,
      [{ id: traceId, projectId, timestamp: eventTs, tags: ["imported:langsmith"], metadata: {} }],
      { eventTs }
    );
    await recordTraceRawRetentionExpired(clickhouse, [
      { projectId, traceId, expiredAt: eventTs }
    ]);

    const res = await get(`/api/v1/traces/${traceId}/raw-events`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      traceId,
      events: [],
      truncated: true,
      retentionExpired: true,
      truncationReason: "retention_expired"
    });
  });

  it("does not mistake a client tag that merely starts with imported: for an importer marker", async () => {
    const traceId = `trace_${ulid()}`;
    const receivedAt = new Date();
    const eventTs = receivedAt.toISOString();
    // "imported:jira" is a user-controlled tag, NOT one of the importer
    // markers (imported:langfuse / imported:langsmith) — this trace was
    // ingested normally and has a raw log that must be found.
    const trace: Trace = {
      id: traceId,
      projectId,
      timestamp: eventTs,
      tags: ["imported:jira"],
      metadata: {}
    };
    await insertTraces(clickhouse, [trace], { eventTs });

    const batchId = ulid();
    const batch: IngestBatch = {
      batchId,
      projectId,
      receivedAt: eventTs,
      events: [
        {
          id: `evt_${ulid()}`,
          type: "trace-upsert",
          source: "native",
          schemaVersion: 1,
          idempotencyKey: "ik_jira_tagged",
          body: { id: traceId, timestamp: eventTs, tags: ["imported:jira"], metadata: {} }
        }
      ]
    };
    const objectKey = rawObjectKey(projectId, receivedAt, batchId);
    await storage.putJson(objectKey, batch);
    await indexRawObjects(traceId, [{ objectKey, receivedAt: eventTs }]);

    const res = await get(`/api/v1/traces/${traceId}/raw-events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { batchId: string }[] };
    expect(body.events.map((e) => e.batchId)).toEqual([batchId]);
  });

  it("returns the explanatory 404 when no raw batch references the trace", async () => {
    const traceId = `trace_${ulid()}`;
    const eventTs = new Date().toISOString();
    const trace: Trace = { id: traceId, projectId, timestamp: eventTs, tags: [], metadata: {} };
    await insertTraces(clickhouse, [trace], { eventTs });
    const res = await get(`/api/v1/traces/${traceId}/raw-events`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no_raw_log");
  });

  it("rejects requests without a valid API key", async () => {
    const res = await app.request(`/api/v1/projects/${projectId}/traces/whatever/raw-events`);
    expect(res.status).toBe(401);
  });
});
