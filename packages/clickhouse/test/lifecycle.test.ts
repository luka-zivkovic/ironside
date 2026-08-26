import { afterAll, describe, expect, it } from "vitest";
import { createClickHouseClient } from "../src/client.js";
import { insertRawEventRefs } from "../src/raw-events.js";
import { runMigrations } from "../src/migrate.js";
import { insertTraces } from "../src/rows.js";
import { summarizeIndexedLifecycleCandidates } from "../src/lifecycle.js";

const client = createClickHouseClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.CLICKHOUSE_USER ?? "ironside",
  password: process.env.CLICKHOUSE_PASSWORD ?? "ironside",
  database: process.env.CLICKHOUSE_DB ?? "ironside"
});

describe("lifecycle inventory", () => {
  afterAll(() => client.close());

  it("counts logical candidates against each project's own cutoff", async () => {
    await runMigrations(client);
    const projectId = `proj_lifecycle_${crypto.randomUUID()}`;
    const oldTraceId = `trace_${crypto.randomUUID()}`;
    const recentTraceId = `trace_${crypto.randomUUID()}`;
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const old = new Date(cutoff.getTime() - 60 * 60 * 1000).toISOString();
    const recent = new Date(cutoff.getTime() + 30 * 60 * 1000).toISOString();
    const eventTs = new Date().toISOString();

    await insertTraces(
      client,
      [
        { id: oldTraceId, projectId, timestamp: old, tags: [], metadata: {} },
        { id: recentTraceId, projectId, timestamp: recent, tags: [], metadata: {} }
      ],
      { eventTs }
    );
    await insertRawEventRefs(
      client,
      [
        { projectId, traceId: oldTraceId, objectKey: `raw/${projectId}/old.json`, receivedAt: old },
        { projectId, traceId: recentTraceId, objectKey: `raw/${projectId}/recent.json`, receivedAt: recent }
      ],
      eventTs
    );
    const [summary] = await summarizeIndexedLifecycleCandidates(client, [
      { projectId, cutoff }
    ]);

    expect(summary).toEqual({
      projectId,
      traces: 1,
      observations: 0,
      scores: 0,
      rawEventRefs: 1
    });
  });
});
