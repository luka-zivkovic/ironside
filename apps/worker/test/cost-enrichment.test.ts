import {
  createClickHouseClient,
  listObservationsForTrace,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import { replaceProjectModelPrices, runMigrations as runPgMigrations } from "@ironside/db";
import { COST_MODEL_METADATA_KEY, COST_SOURCE_METADATA_KEY, COST_TABLE_METADATA_KEY } from "@ironside/pricing";
import { createIngestQueue, enqueueBatch } from "@ironside/queue";
import type { IngestBatch, IngestEvent } from "@ironside/shared";
import { INGEST_SCHEMA_VERSION, pendingIngestObjectKey, rawObjectKey } from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { resetModelPriceOverrideCache } from "../src/processors/cost-enrichment.js";
import { createIngestProcessor } from "../src/processors/ingest.js";

// Runs the REAL ingest processor over a native batch and reads the rows back
// from ClickHouse: cost must be derived for usage-bearing generations that
// sent none, left alone when the client sent it, and absent for unknown
// models — with provenance in metadata for every derived number.

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);
const processBatch = createIngestProcessor({ storage, clickhouse, pool });

let projectId: string;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();
  const orgId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [orgId, "cost-enrichment-test-org"]);
  await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
    projectId,
    orgId,
    "cost-enrichment-test"
  ]);
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'cost-enrichment-test-org'");
  await queue.close();
  await pool.end();
  await clickhouse.close();
  storage.close();
});

function nativeEvent(type: "trace-upsert" | "observation-upsert", body: unknown): IngestEvent {
  return { id: ulid(), type, source: "native", schemaVersion: INGEST_SCHEMA_VERSION, idempotencyKey: ulid(), body };
}

async function ingest(events: IngestEvent[]) {
  const batch: IngestBatch = { batchId: ulid(), projectId, receivedAt: new Date().toISOString(), events };
  const objectKey = rawObjectKey(projectId, new Date(batch.receivedAt), batch.batchId);
  await storage.putJson(objectKey, batch);
  const message = { batchId: batch.batchId, projectId, objectKey, eventCount: events.length };
  await storage.putJson(pendingIngestObjectKey(batch.batchId), message);
  await enqueueBatch(queue, message);
  const job = await queue.getJob(batch.batchId);
  if (!job) throw new Error("job not found after enqueue");
  await processBatch(job);
}

function observation(traceId: string, id: string, extra: Record<string, unknown>) {
  const now = new Date().toISOString();
  return { id, traceId, type: "generation", name: id, startTime: now, endTime: now, ...extra };
}

describe("cost enrichment at ingest", () => {
  it("derives cost from the vendored table, keeps client cost, and skips unknown models", async () => {
    const traceId = `trace_${ulid()}`;
    await ingest([
      nativeEvent("trace-upsert", { id: traceId, timestamp: new Date().toISOString(), name: "cost" }),
      nativeEvent("observation-upsert", observation(traceId, "derived", {
        model: "gpt-4o-mini",
        usageDetails: { input_tokens: 1_000_000, output_tokens: 1_000_000 }
      })),
      nativeEvent("observation-upsert", observation(traceId, "client", {
        model: "gpt-4o-mini",
        usageDetails: { input_tokens: 1_000_000 },
        costDetails: { total: 0.42 }
      })),
      nativeEvent("observation-upsert", observation(traceId, "unknown", {
        model: "totally-unknown-model",
        usageDetails: { input_tokens: 10 }
      })),
      nativeEvent("observation-upsert", observation(traceId, "no-usage", { model: "gpt-4o-mini" }))
    ]);

    const rows = await listObservationsForTrace(clickhouse, projectId, traceId);
    const byId = new Map(rows.map((row) => [row.id, row]));

    const derived = byId.get("derived")!;
    expect(derived.cost_details.total).toBeGreaterThan(0);
    expect(derived.cost_details.input).toBeCloseTo(0.15, 6);
    expect(derived.cost_details.output).toBeCloseTo(0.6, 6);
    expect(derived.metadata[COST_SOURCE_METADATA_KEY]).toBe("table");
    expect(derived.metadata[COST_MODEL_METADATA_KEY]).toBe("gpt-4o-mini");
    expect(derived.metadata[COST_TABLE_METADATA_KEY]).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(byId.get("client")!.cost_details).toEqual({ total: 0.42 });
    expect(byId.get("client")!.metadata[COST_SOURCE_METADATA_KEY]).toBeUndefined();
    expect(byId.get("unknown")!.cost_details).toEqual({});
    expect(byId.get("no-usage")!.cost_details).toEqual({});
  });

  it("prefers a project override over the table", async () => {
    await replaceProjectModelPrices(pool, projectId, [
      {
        pattern: "^gpt-4o",
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002,
        cacheReadInputTokenCost: null,
        cacheWriteInputTokenCost: null
      }
    ]);
    resetModelPriceOverrideCache();

    const traceId = `trace_${ulid()}`;
    await ingest([
      nativeEvent("trace-upsert", { id: traceId, timestamp: new Date().toISOString(), name: "override" }),
      nativeEvent("observation-upsert", observation(traceId, "overridden", {
        model: "gpt-4o-mini",
        usageDetails: { input_tokens: 1000, output_tokens: 1000 }
      }))
    ]);

    const [row] = await listObservationsForTrace(clickhouse, projectId, traceId);
    expect(row!.cost_details).toEqual({ input: 0.001, output: 0.002, total: 0.003 });
    expect(row!.metadata[COST_SOURCE_METADATA_KEY]).toBe("override");
    expect(row!.metadata[COST_MODEL_METADATA_KEY]).toBe("^gpt-4o");
    expect(row!.metadata[COST_TABLE_METADATA_KEY]).toBeUndefined();
  });
});
