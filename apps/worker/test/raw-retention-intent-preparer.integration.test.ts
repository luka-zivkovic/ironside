import {
  createClickHouseClient,
  getRawObjectRefSnapshot,
  getTraceRawRetentionExpiredMap,
  insertRawEventRefs,
  runMigrations as runClickHouseMigrations
} from "@ironside/clickhouse";
import {
  claimRawRetentionIntentExecution,
  createRawRetentionIntents,
  getRawRetentionIntent,
  listRawRetentionIntents,
  runMigrations as runPostgresMigrations
} from "@ironside/db";
import { createIngestQueue } from "@ironside/queue";
import { rawObjectKey } from "@ironside/shared";
import { createObjectStorage, type ObjectStorage } from "@ironside/storage";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { prepareRawRetentionIntents } from "../src/retention/raw-retention-intent-preparer.js";
import { executeRawRetentionIntents } from "../src/retention/raw-retention-intent-executor.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);
const organizationId = `org_${ulid()}`;
const projectId = `proj_${ulid()}`;
const batchId = ulid();
const traceId = `trace_${ulid()}`;
const receivedAt = new Date("2025-01-01T12:00:00.000Z");
const objectKey = rawObjectKey(projectId, receivedAt, batchId);

beforeAll(async () => {
  await runPostgresMigrations(pool);
  await runClickHouseMigrations(clickhouse);
  await storage.ensureBucket();
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    organizationId,
    "raw-retention-preparer-integration"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, organizationId, "raw-retention-preparer-integration"]
  );
  await storage.putJson(objectKey, {
    batchId,
    projectId,
    receivedAt: receivedAt.toISOString(),
    events: [
      {
        id: `evt_${ulid()}`,
        type: "trace-upsert",
        source: "native",
        schemaVersion: 1,
        idempotencyKey: "retention-preparer-integration",
        body: { id: traceId, timestamp: receivedAt.toISOString() }
      }
    ]
  });
  // Model the state after domain retention: the durable raw ref remains, but
  // traces/observations/scores have no query-visible row for this identity.
  await insertRawEventRefs(
    clickhouse,
    [{ projectId, traceId, objectKey, receivedAt: receivedAt.toISOString() }],
    receivedAt.toISOString()
  );
});

afterAll(async () => {
  await storage.delete(objectKey);
  await pool.query("delete from raw_retention_intents where project_id = $1", [projectId]);
  await pool.query("delete from organizations where id = $1", [organizationId]);
  await queue.close();
  await pool.end();
  await clickhouse.close();
  storage.close();
});

describe("raw retention intent preparation (live stores)", () => {
  it("prepares explicitly, expires refs, and deletes the raw object last", async () => {
    const result = await prepareRawRetentionIntents({
      pool,
      clickhouse,
      storage,
      queue,
      projectId,
      objectKeys: [objectKey],
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z"),
      preparationId: `rtp_${ulid()}`
    });

    expect(result.prepared).toEqual([
      expect.objectContaining({ objectKey, classification: "applied" })
    ]);
    expect(await storage.exists(objectKey)).toBe(true);
    expect(await listRawRetentionIntents(pool, projectId, "prepared", 10)).toEqual([
      expect.objectContaining({ projectId, objectKey, traceIds: [traceId] })
    ]);
    const expired = await getTraceRawRetentionExpiredMap(clickhouse, projectId, [traceId]);
    expect(expired.get(traceId)).not.toBe(true);

    const intentId = result.prepared[0]?.intentId;
    if (!intentId) throw new Error("expected a prepared raw retention intent");
    const executed = await executeRawRetentionIntents({
      pool,
      clickhouse,
      storage,
      queue,
      projectId,
      intentIds: [intentId],
      defaultRetentionDays: 90,
      executionEnabled: true,
      confirmation: "execute",
      now: new Date("2026-08-21T00:00:00.000Z")
    });

    expect(executed).toMatchObject({
      lockAcquired: true,
      completed: [{ intentId, objectKey, objectSizeBytes: expect.any(Number) }],
      blocked: []
    });
    expect(await storage.exists(objectKey)).toBe(false);
    expect(await getRawRetentionIntent(pool, projectId, objectKey)).toMatchObject({
      state: "complete",
      attempts: 1
    });
    expect(
      (await getTraceRawRetentionExpiredMap(clickhouse, projectId, [traceId])).get(traceId)
    ).toBe(true);
    expect(await getRawObjectRefSnapshot(clickhouse, projectId, objectKey, 10)).toMatchObject({
      refs: [{ traceId, applied: 2 }],
      truncated: false
    });

    // A delayed ingest retry can only write lower ref versions; state 2 wins.
    await insertRawEventRefs(
      clickhouse,
      [{ projectId, traceId, objectKey, receivedAt: receivedAt.toISOString() }],
      receivedAt.toISOString(),
      true
    );
    expect(await getRawObjectRefSnapshot(clickhouse, projectId, objectKey, 10)).toMatchObject({
      refs: [{ traceId, applied: 2 }]
    });

    const retry = await executeRawRetentionIntents({
      pool,
      clickhouse,
      storage,
      queue,
      projectId,
      intentIds: [intentId],
      defaultRetentionDays: 90,
      executionEnabled: true,
      confirmation: "execute",
      now: new Date("2026-08-21T00:00:00.000Z")
    });
    expect(retry.alreadyComplete).toEqual([{ intentId, objectKey }]);
  });

  it("resumes safely after marker/ref cleanup succeeds but raw deletion fails", async () => {
    const retryBatchId = ulid();
    const retryTraceId = `trace_${ulid()}`;
    const retryReceivedAt = new Date("2025-02-01T12:00:00.000Z");
    const retryObjectKey = rawObjectKey(projectId, retryReceivedAt, retryBatchId);
    await storage.putJson(retryObjectKey, {
      batchId: retryBatchId,
      projectId,
      receivedAt: retryReceivedAt.toISOString(),
      events: [
        {
          id: `evt_${ulid()}`,
          type: "trace-upsert",
          source: "native",
          schemaVersion: 1,
          idempotencyKey: "retention-crash-resume",
          body: { id: retryTraceId, timestamp: retryReceivedAt.toISOString() }
        }
      ]
    });
    await insertRawEventRefs(
      clickhouse,
      [
        {
          projectId,
          traceId: retryTraceId,
          objectKey: retryObjectKey,
          receivedAt: retryReceivedAt.toISOString()
        }
      ],
      retryReceivedAt.toISOString()
    );
    const prepared = await prepareRawRetentionIntents({
      pool,
      clickhouse,
      storage,
      queue,
      projectId,
      objectKeys: [retryObjectKey],
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z"),
      preparationId: `rtp_${ulid()}`
    });
    const retryIntentId = prepared.prepared[0]?.intentId;
    if (!retryIntentId) throw new Error("expected a prepared crash-resume intent");

    let failRawDelete = true;
    const faultStorage: ObjectStorage = {
      ...storage,
      async delete(key: string) {
        if (key === retryObjectKey && failRawDelete) {
          failRawDelete = false;
          throw new Error("injected raw delete failure");
        }
        await storage.delete(key);
      }
    };
    await expect(
      executeRawRetentionIntents({
        pool,
        clickhouse,
        storage: faultStorage,
        queue,
        projectId,
        intentIds: [retryIntentId],
        defaultRetentionDays: 90,
        executionEnabled: true,
        confirmation: "execute",
        now: new Date("2026-08-21T00:00:00.000Z")
      })
    ).rejects.toThrow("injected raw delete failure");

    expect(await storage.exists(retryObjectKey)).toBe(true);
    expect(await getRawRetentionIntent(pool, projectId, retryObjectKey)).toMatchObject({
      state: "executing",
      attempts: 1,
      lastError: "injected raw delete failure"
    });
    expect(
      await getRawObjectRefSnapshot(clickhouse, projectId, retryObjectKey, 10)
    ).toMatchObject({ refs: [{ traceId: retryTraceId, applied: 2 }] });

    const resumed = await executeRawRetentionIntents({
      pool,
      clickhouse,
      storage,
      queue,
      projectId,
      intentIds: [retryIntentId],
      defaultRetentionDays: 90,
      executionEnabled: true,
      confirmation: "execute",
      now: new Date("2026-08-21T00:00:00.000Z")
    });
    expect(resumed.completed).toEqual([
      expect.objectContaining({ intentId: retryIntentId, objectKey: retryObjectKey })
    ]);
    expect(await storage.exists(retryObjectKey)).toBe(false);
    expect(await getRawRetentionIntent(pool, projectId, retryObjectKey)).toMatchObject({
      state: "complete",
      attempts: 2,
      lastError: null
    });
    const markerRows = await clickhouse.query({
      query: `select count() as count from raw_event_trace_retention
              where project_id = {projectId:String} and trace_id = {traceId:String}`,
      query_params: { projectId, traceId: retryTraceId },
      format: "JSONEachRow"
    });
    expect(await markerRows.json()).toEqual([{ count: "1" }]);
    const physicalRefs = await clickhouse.query({
      query: `select count() as count from raw_event_refs
              where project_id = {projectId:String} and object_key = {objectKey:String}`,
      query_params: { projectId, objectKey: retryObjectKey },
      format: "JSONEachRow"
    });
    expect(await physicalRefs.json()).toEqual([{ count: "2" }]);
  });

  it("completes a proven post-delete crash despite a later policy change", async () => {
    const batchIdAfterDelete = ulid();
    const traceIdAfterDelete = `trace_${ulid()}`;
    const receivedAtAfterDelete = new Date("2025-03-01T12:00:00.000Z");
    const objectKeyAfterDelete = rawObjectKey(
      projectId,
      receivedAtAfterDelete,
      batchIdAfterDelete
    );
    await storage.putJson(objectKeyAfterDelete, {
      batchId: batchIdAfterDelete,
      projectId,
      receivedAt: receivedAtAfterDelete.toISOString(),
      events: [
        {
          id: `evt_${ulid()}`,
          type: "trace-upsert",
          source: "native",
          schemaVersion: 1,
          idempotencyKey: "retention-post-delete-convergence",
          body: { id: traceIdAfterDelete, timestamp: receivedAtAfterDelete.toISOString() }
        }
      ]
    });
    await insertRawEventRefs(
      clickhouse,
      [
        {
          projectId,
          traceId: traceIdAfterDelete,
          objectKey: objectKeyAfterDelete,
          receivedAt: receivedAtAfterDelete.toISOString()
        }
      ],
      receivedAtAfterDelete.toISOString()
    );
    const prepared = await prepareRawRetentionIntents({
      pool,
      clickhouse,
      storage,
      queue,
      projectId,
      objectKeys: [objectKeyAfterDelete],
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z"),
      preparationId: `rtp_${ulid()}`
    });
    const intentIdAfterDelete = prepared.prepared[0]?.intentId;
    if (!intentIdAfterDelete) throw new Error("expected a post-delete crash intent");

    let failCompletion = true;
    const completionFaultPool = {
      connect: pool.connect.bind(pool),
      query: (text: string, params?: unknown[]) => {
        if (failCompletion && text.includes("set state = 'complete'")) {
          failCompletion = false;
          return Promise.reject(new Error("injected completion update failure"));
        }
        return pool.query(text, params);
      }
    } as unknown as Pool;
    await expect(
      executeRawRetentionIntents({
        pool: completionFaultPool,
        clickhouse,
        storage,
        queue,
        projectId,
        intentIds: [intentIdAfterDelete],
        defaultRetentionDays: 90,
        executionEnabled: true,
        confirmation: "execute",
        now: new Date("2026-08-21T00:00:00.000Z")
      })
    ).rejects.toThrow("injected completion update failure");
    expect(await storage.exists(objectKeyAfterDelete)).toBe(false);
    expect(await getRawRetentionIntent(pool, projectId, objectKeyAfterDelete)).toMatchObject({
      state: "executing",
      lastError: "injected completion update failure"
    });

    await pool.query("update projects set retention_days = 10000 where id = $1", [projectId]);
    try {
      const postDeleteStorage = {
        ...storage,
        async putJson(key: string, value: unknown) {
          if (key.includes("/.retention-probes/")) {
            throw new Error("post-delete convergence must not run destructive probes");
          }
          await storage.putJson(key, value);
        }
      } as ObjectStorage;
      const converged = await executeRawRetentionIntents({
        pool,
        clickhouse,
        storage: postDeleteStorage,
        queue,
        projectId,
        intentIds: [intentIdAfterDelete],
        defaultRetentionDays: 90,
        executionEnabled: true,
        confirmation: "execute",
        now: new Date("2026-08-21T00:00:00.000Z")
      });
      expect(converged.completed).toEqual([
        expect.objectContaining({
          intentId: intentIdAfterDelete,
          objectKey: objectKeyAfterDelete
        })
      ]);
      expect(await getRawRetentionIntent(pool, projectId, objectKeyAfterDelete)).toMatchObject({
        state: "complete",
        lastError: null
      });
    } finally {
      await pool.query("update projects set retention_days = null where id = $1", [projectId]);
    }
  });

  it("never treats an executing zero-ref intent as proof that a missing object was deleted", async () => {
    const zeroRefBatchId = ulid();
    const zeroRefObjectKey = rawObjectKey(
      projectId,
      new Date("2025-04-01T00:00:00.000Z"),
      zeroRefBatchId
    );
    const zeroRefIntentId = `rti_${ulid()}`;
    await createRawRetentionIntents(pool, [
      {
        id: zeroRefIntentId,
        preparationId: `rtp_${ulid()}`,
        projectId,
        ingestBatchId: zeroRefBatchId,
        objectKey: zeroRefObjectKey,
        objectSizeBytes: 0,
        retentionCutoffDay: "2026-05-23",
        effectiveRetentionDays: 90,
        traceIds: [],
        classification: "terminal_failed",
        diagnosticCount: 0
      }
    ]);
    await claimRawRetentionIntentExecution(pool, projectId, zeroRefIntentId);

    const result = await executeRawRetentionIntents({
      pool,
      clickhouse,
      storage,
      queue,
      projectId,
      intentIds: [zeroRefIntentId],
      defaultRetentionDays: 90,
      executionEnabled: true,
      confirmation: "execute",
      now: new Date("2026-08-21T00:00:00.000Z")
    });

    expect(result.blocked).toEqual([
      {
        intentId: zeroRefIntentId,
        objectKey: zeroRefObjectKey,
        reason: "no_authoritative_trace_refs"
      }
    ]);
    expect(await getRawRetentionIntent(pool, projectId, zeroRefObjectKey)).toMatchObject({
      state: "executing",
      lastError: "no_authoritative_trace_refs"
    });
  });
});
