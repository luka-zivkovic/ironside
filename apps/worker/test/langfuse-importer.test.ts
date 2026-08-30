import { createServer, type Server } from "node:http";
import { createClickHouseClient, runMigrations as runChMigrations } from "@ironside/clickhouse";
import {
  claimImportRun,
  getEvaluatorTracePublications,
  getImportCheckpoint,
  listPendingEvaluatorImportTraceIds,
  runMigrations as runPgMigrations,
  stageEvaluatorImportTraces
} from "@ironside/db";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runLangfuseImport } from "../src/importers/langfuse-importer.js";
import {
  importedTraceContentHash,
  recoverAbandonedEvaluatorImports
} from "../src/importers/evaluator-publication.js";
import { loadConfig } from "../src/config.js";

// Integration test against a real Postgres + ClickHouse (compose stack)
// and a minimal mock LangFuse HTTP server — validates the actual
// pagination/checkpoint/resume behavior end to end, not just the mapper
// function in isolation.

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);

let projectId: string;
let server: Server;
let serverUrl: string;
let requestLog: { page: string | null; fromTimestamp: string | null }[] = [];

/** All traces the mock server will serve, oldest-first, paginated by the test itself. */
let fixtureTraces: { id: string; timestamp: string; name: string }[] = [];
let pageSize = 2;
/** Per-trace detail payloads (observations/scores/extra fields) merged into the detail endpoint's response; traces without an entry get empty arrays. `failWith` makes the detail endpoint return that HTTP status instead. */
let fixtureDetails: Record<string, { observations?: unknown[]; scores?: unknown[]; environment?: string; failWith?: number }> = {};

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  const orgId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "langfuse-importer-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, "langfuse-importer-test"]
  );

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("content-type", "application/json");

    // GET /api/public/traces/{id} — the full-detail endpoint the importer
    // now calls once per listed trace.
    const detailMatch = /^\/api\/public\/traces\/([^/]+)$/.exec(url.pathname);
    if (detailMatch) {
      const trace = fixtureTraces.find((t) => t.id === decodeURIComponent(detailMatch[1]!));
      const extras = trace ? fixtureDetails[trace.id] : undefined;
      if (!trace || extras?.failWith) {
        res.statusCode = extras?.failWith ?? 404;
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const { failWith: _unused, ...detailExtras } = extras ?? {};
      res.end(JSON.stringify({ ...trace, observations: [], scores: [], ...detailExtras }));
      return;
    }

    const page = Number(url.searchParams.get("page") ?? "1");
    const fromTimestamp = url.searchParams.get("fromTimestamp");
    requestLog.push({ page: url.searchParams.get("page"), fromTimestamp });

    const filtered = fromTimestamp
      ? fixtureTraces.filter((t) => t.timestamp >= fromTimestamp)
      : fixtureTraces;
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const start = (page - 1) * pageSize;
    const data = filtered.slice(start, start + pageSize);

    res.end(
      JSON.stringify({
        data,
        meta: { page, limit: pageSize, totalItems: filtered.length, totalPages }
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address && typeof address === "object") {
    serverUrl = `http://localhost:${address.port}`;
  }
});

beforeEach(() => {
  requestLog = [];
  fixtureDetails = {};
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'langfuse-importer-test-org'");
  await pool.end();
  await clickhouse.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await pool.query(
    "delete from import_checkpoints where project_id = $1 and source = 'langfuse'",
    [projectId]
  );
});

function clientConfig() {
  return { baseUrl: serverUrl, publicKey: "pk_test", secretKey: "sk_test" };
}

describe("runLangfuseImport", () => {
  it("imports all traces across multiple pages and marks the checkpoint idle with page reset", async () => {
    fixtureTraces = Array.from({ length: 5 }, (_, i) => ({
      id: `trace_${ulid()}`,
      timestamp: `2026-07-12T00:00:0${i}.000Z`,
      name: `trace-${i}`
    }));

    const result = await runLangfuseImport({
      pool,
      clickhouse,
      projectId,
      client: clientConfig(),
      pageSize: 2
    });

    expect(result?.imported).toBe(5);
    expect(result?.resumable).toBe(false);

    const checkpoint = await getImportCheckpoint(pool, projectId, "langfuse");
    expect(checkpoint?.status).toBe("idle");
    expect(checkpoint?.importedCount).toBe(5);
    expect(checkpoint?.checkpoint.page).toBe(1); // reset after exhausting all pages
    expect(checkpoint?.checkpoint.lastTimestamp).toBe("2026-07-12T00:00:04.000Z");

    const ids = fixtureTraces.map((t) => t.id);
    const rows = await clickhouse.query({
      query: `select id from traces final where project_id = {projectId:String} and id in ({ids:Array(String)})`,
      query_params: { projectId, ids },
      format: "JSONEachRow"
    });
    expect((await rows.json()).length).toBe(5);
  });

  it("resumes from the saved checkpoint instead of re-importing from scratch (fromTimestamp is used on the next run)", async () => {
    fixtureTraces = Array.from({ length: 3 }, (_, i) => ({
      id: `trace_${ulid()}`,
      timestamp: `2026-07-12T01:00:0${i}.000Z`,
      name: `trace-${i}`
    }));

    await runLangfuseImport({ pool, clickhouse, projectId, client: clientConfig(), pageSize: 10 });
    requestLog = [];

    // Add more traces "created after" the first run and rerun — should
    // only fetch from the checkpointed lastTimestamp forward.
    const newer = { id: `trace_${ulid()}`, timestamp: "2026-07-12T01:00:05.000Z", name: "new" };
    fixtureTraces.push(newer);

    const result = await runLangfuseImport({
      pool,
      clickhouse,
      projectId,
      client: clientConfig(),
      pageSize: 10
    });

    expect(requestLog[0]?.fromTimestamp).toBe("2026-07-12T01:00:02.000Z");
    // The last-seen trace from the prior run is re-fetched too (>= boundary
    // is inclusive), so imported count on the resume run is 2 (last-seen +
    // new), not just the 1 new trace — a real re-insert, not a bug, since
    // ClickHouse upserts by id.
    expect(result?.imported).toBeGreaterThanOrEqual(1);

    const rows = await clickhouse.query({
      query: `select id from traces final where project_id = {projectId:String} and id = {id:String}`,
      query_params: { projectId, id: newer.id },
      format: "JSONEachRow"
    });
    expect((await rows.json()).length).toBe(1);
  });

  it("stops after maxPagesPerRun and reports resumable=true, without losing progress", async () => {
    fixtureTraces = Array.from({ length: 6 }, (_, i) => ({
      id: `trace_${ulid()}`,
      timestamp: `2026-07-12T02:00:0${i}.000Z`,
      name: `trace-${i}`
    }));

    const result = await runLangfuseImport({
      pool,
      clickhouse,
      projectId,
      client: clientConfig(),
      pageSize: 2,
      maxPagesPerRun: 1
    });

    expect(result?.resumable).toBe(true);
    expect(result?.imported).toBe(2);
    const checkpoint = await getImportCheckpoint(pool, projectId, "langfuse");
    expect(checkpoint?.status).toBe("idle");
    expect(checkpoint?.checkpoint.page).toBe(2); // not reset — more pages remain
  });

  it("a capped run followed by resume calls imports EVERYTHING — the checkpoint's page stays consistent with its anchor across runs", async () => {
    // Regression test for a bug caught by the M5 conformance run against a
    // REAL LangFuse account (51 traces, pageSize=10, maxPagesPerRun=3):
    // the checkpoint saved the incremented page number together with an
    // ADVANCED lastTimestamp, but that page was counted against the
    // window anchored at the run's ORIGINAL timestamp. The next run
    // re-anchored its window at the new lastTimestamp — renumbering every
    // page — queried a page beyond that smaller window's end, got an
    // empty response, and falsely concluded the source was exhausted,
    // silently leaving 21 of 51 traces unimported. The pre-existing
    // "stops after maxPagesPerRun" test asserted the checkpoint's shape
    // after the capped run but never actually resumed to completion —
    // exactly the missing assertion.
    fixtureTraces = Array.from({ length: 7 }, (_, i) => ({
      id: `trace_${ulid()}`,
      timestamp: `2026-07-12T04:00:0${i}.000Z`,
      name: `capped-resume-${i}`
    }));

    let total = 0;
    let calls = 0;
    for (;;) {
      const result = await runLangfuseImport({
        pool,
        clickhouse,
        projectId,
        client: clientConfig(),
        pageSize: 2,
        maxPagesPerRun: 2
      });
      expect(result).not.toBeNull();
      total += result!.imported;
      calls += 1;
      if (!result!.resumable) break;
      expect(calls).toBeLessThan(10); // runaway guard
    }

    // Resume re-fetches the boundary trace (fromTimestamp inclusive), so
    // the SUM of per-run imported counts can exceed 7 — what must hold is
    // that every distinct trace actually arrived.
    expect(total).toBeGreaterThanOrEqual(7);
    const ids = fixtureTraces.map((t) => t.id);
    const rows = await clickhouse.query({
      query: `select distinct id from traces final where project_id = {projectId:String} and id in {ids:Array(String)}`,
      query_params: { projectId, ids },
      format: "JSONEachRow"
    });
    expect((await rows.json()).length).toBe(7);
  });

  it("imports the FULL trace: observations (typed, levelled, usage/cost/params) and scores (original timestamps preserved)", async () => {
    const traceId = `trace_${ulid()}`;
    const obsId = `obs_${ulid()}`;
    const childObsId = `obs_${ulid()}`;
    const scoreId = `score_${ulid()}`;
    fixtureTraces = [{ id: traceId, timestamp: "2026-07-12T05:00:00.000Z", name: "full-data" }];
    fixtureDetails = {
      [traceId]: {
        environment: "production",
        observations: [
          {
            id: obsId,
            traceId,
            parentObservationId: null,
            type: "SPAN", // uppercase, as the real API returns
            name: "handler",
            startTime: "2026-07-12T05:00:00.000Z",
            endTime: "2026-07-12T05:00:01.000Z",
            level: "DEFAULT"
          },
          {
            id: childObsId,
            traceId,
            parentObservationId: obsId,
            type: "GENERATION",
            name: "llm-call",
            startTime: "2026-07-12T05:00:00.100Z",
            endTime: "2026-07-12T05:00:00.900Z",
            completionStartTime: "2026-07-12T05:00:00.300Z",
            level: "WARNING",
            statusMessage: "slow response",
            model: "gpt-4o",
            modelParameters: { temperature: 0.7, max_tokens: 512 },
            input: [{ role: "user", content: "hi" }],
            output: { role: "assistant", content: "hello" },
            usageDetails: { input: 12, output: 34, total: 46 },
            costDetails: { input: 0.001, output: 0.003, total: 0.004 },
            metadata: { region: "eu" },
            promptName: "greeting-v2",
            promptVersion: 3
          }
        ],
        scores: [
          {
            id: scoreId,
            traceId,
            observationId: childObsId,
            name: "user-feedback",
            value: 0,
            stringValue: "dislike",
            dataType: "CATEGORICAL",
            source: "API",
            comment: "too slow",
            timestamp: "2026-07-11T09:30:00.000Z" // the ORIGINAL score time, well before import time
          }
        ]
      }
    };

    const result = await runLangfuseImport({ pool, clickhouse, projectId, client: clientConfig(), pageSize: 10 });
    expect(result?.imported).toBe(1);

    const obsRows = await clickhouse.query({
      query: `select id, parent_observation_id, type, name, level, status_message, model, model_parameters, usage_details, cost_details, completion_start_time, metadata from observations final where project_id = {projectId:String} and trace_id = {traceId:String} order by start_time`,
      query_params: { projectId, traceId },
      format: "JSONEachRow"
    });
    const observations = (await obsRows.json()) as {
      id: string; parent_observation_id: string | null; type: string; name: string;
      level: string; status_message: string | null; model: string | null;
      model_parameters: Record<string, string>; usage_details: Record<string, string | number>;
      cost_details: Record<string, string | number>; completion_start_time: string | null;
      metadata: Record<string, string>;
    }[];
    expect(observations).toHaveLength(2);

    const parent = observations.find((o) => o.id === obsId)!;
    expect(parent.type).toBe("span"); // uppercase normalized to Ironside's lowercase enum
    expect(parent.parent_observation_id).toBeNull();

    const child = observations.find((o) => o.id === childObsId)!;
    expect(child.type).toBe("generation");
    expect(child.parent_observation_id).toBe(obsId);
    expect(child.level).toBe("warning");
    expect(child.status_message).toBe("slow response");
    expect(child.model).toBe("gpt-4o");
    expect(child.model_parameters).toEqual({ temperature: "0.7", max_tokens: "512" });
    expect(Number(child.usage_details.input_tokens)).toBe(12);
    expect(Number(child.usage_details.output_tokens)).toBe(34);
    expect(Number(child.cost_details.total)).toBeCloseTo(0.004);
    expect(child.completion_start_time).toBeTruthy();
    expect(child.metadata.region).toBe("eu");
    // Prompt linkage preserved via metadata — no dedicated column exists.
    expect(child.metadata["langfuse:promptName"]).toBe("greeting-v2");
    expect(child.metadata["langfuse:promptVersion"]).toBe("3");

    const scoreRows = await clickhouse.query({
      query: `select id, observation_id, name, data_type, value, string_value, source, comment, timestamp from scores final where project_id = {projectId:String} and trace_id = {traceId:String}`,
      query_params: { projectId, traceId },
      format: "JSONEachRow"
    });
    const scores = (await scoreRows.json()) as {
      id: string; observation_id: string | null; name: string; data_type: string;
      value: number | null; string_value: string | null; source: string;
      comment: string | null; timestamp: string;
    }[];
    expect(scores).toHaveLength(1);
    const score = scores[0]!;
    expect(score.observation_id).toBe(childObsId);
    expect(score.data_type).toBe("categorical");
    expect(score.value).toBe(0); // value 0 is meaningful, must not be dropped by a truthiness check
    expect(score.string_value).toBe("dislike");
    expect(score.source).toBe("api");
    expect(score.comment).toBe("too slow");
    // The ORIGINAL score timestamp survives the import — without the new
    // Score.timestamp field, ClickHouse would default this to insert time.
    expect(score.timestamp.startsWith("2026-07-11")).toBe(true);
    const publication = (await getEvaluatorTracePublications(pool, projectId, [traceId]))
      .get(traceId);
    expect(publication).toBeDefined();
    expect((await listPendingEvaluatorImportTraceIds(pool, projectId, [traceId])).has(traceId))
      .toBe(false);

    // The trace itself carries the detail-only environment field.
    const traceRows = await clickhouse.query({
      query: `select environment from traces final where project_id = {projectId:String} and id = {traceId:String}`,
      query_params: { projectId, traceId },
      format: "JSONEachRow"
    });
    expect(((await traceRows.json()) as { environment: string }[])[0]?.environment).toBe("production");
  });

  it("tombstones observations omitted by a later full snapshot", async () => {
    const traceId = `trace_${ulid()}`;
    const retainedId = `obs_${ulid()}`;
    const removedId = `obs_${ulid()}`;
    const trace = { id: traceId, timestamp: "2026-07-12T05:30:00.000Z", name: "changing" };
    fixtureTraces = [trace];
    const observation = (id: string) => ({
      id,
      traceId,
      type: "SPAN",
      startTime: "2026-07-12T05:30:00.000Z",
      level: "DEFAULT"
    });
    fixtureDetails = {
      [traceId]: { observations: [observation(retainedId), observation(removedId)] }
    };
    await runLangfuseImport({ pool, clickhouse, projectId, client: clientConfig(), pageSize: 10 });

    fixtureDetails = { [traceId]: { observations: [observation(retainedId)] } };
    await runLangfuseImport({ pool, clickhouse, projectId, client: clientConfig(), pageSize: 10 });

    const rows = await clickhouse.query({
      query: `select id from observations final
               where project_id = {projectId:String} and trace_id = {traceId:String}
               order by id`,
      query_params: { projectId, traceId },
      format: "JSONEachRow"
    });
    expect(await rows.json()).toEqual([{ id: retainedId }]);
  });

  it("recovers a durable staged snapshot after its import lease expires", async () => {
    const traceId = `trace_${ulid()}`;
    const runToken = `import_crashed_${ulid()}`;
    await claimImportRun(pool, projectId, "langfuse", runToken);
    const trace = {
      id: traceId,
      projectId,
      timestamp: "2026-07-12T05:45:00.000Z",
      name: "crash-recovery",
      tags: [],
      metadata: {}
    };
    await stageEvaluatorImportTraces(pool, {
      projectId,
      source: "langfuse",
      runToken,
      candidateActivityId: `import_${ulid()}`,
      candidateActivityAt: "2026-08-30T12:00:00.000Z",
      traces: [{
        traceId,
        contentHash: importedTraceContentHash(trace, []),
        snapshot: {
          trace,
          observations: [],
          scores: [],
          scoreActivityAt: "2026-08-30T12:00:00.000Z"
        }
      }]
    });
    await pool.query(
      `update import_checkpoints
          set lease_expires_at = clock_timestamp() - interval '1 second'
        where project_id = $1 and source = 'langfuse'`,
      [projectId]
    );

    await expect(recoverAbandonedEvaluatorImports({
      pool,
      clickhouse,
      limit: 10
    })).resolves.toBe(1);
    expect((await listPendingEvaluatorImportTraceIds(pool, projectId, [traceId])).has(traceId))
      .toBe(false);
    expect((await getEvaluatorTracePublications(pool, projectId, [traceId])).has(traceId))
      .toBe(true);
  });

  it("a failed detail fetch fails the run without advancing the checkpoint past that page", async () => {
    // Two traces on one page; the second's detail endpoint returns 500.
    // The run must fail (not silently import a partial page), and the
    // checkpoint must NOT record this page as done — a retry re-fetches
    // the whole page and its details idempotently.
    const okId = `trace_${ulid()}`;
    const brokenId = `trace_${ulid()}`;
    fixtureTraces = [
      { id: okId, timestamp: "2026-07-12T06:00:00.000Z", name: "ok" },
      { id: brokenId, timestamp: "2026-07-12T06:00:01.000Z", name: "broken-detail" }
    ];
    fixtureDetails = { [brokenId]: { failWith: 500 } };

    await expect(
      runLangfuseImport({ pool, clickhouse, projectId, client: clientConfig(), pageSize: 10 })
    ).rejects.toThrow(/500/);

    const checkpoint = await getImportCheckpoint(pool, projectId, "langfuse");
    expect(checkpoint?.status).toBe("error");
    // No anchor was saved for the failed page — the retry starts over
    // from the same window position rather than skipping past it.
    expect(checkpoint?.checkpoint?.lastTimestamp).toBeUndefined();

    // And the retry (after the detail endpoint recovers) imports both.
    fixtureDetails = {};
    const retry = await runLangfuseImport({ pool, clickhouse, projectId, client: clientConfig(), pageSize: 10 });
    expect(retry?.imported).toBe(2);
  });

  it("a concurrent call while a run is already 'running' returns null instead of racing the checkpoint", async () => {
    fixtureTraces = [{ id: `trace_${ulid()}`, timestamp: "2026-07-12T03:00:00.000Z", name: "x" }];

    // Manually put the checkpoint into a running state to simulate an
    // in-flight run without actually holding one open concurrently.
    await pool.query(
      `insert into import_checkpoints
         (id, project_id, source, status, run_token, lease_expires_at)
       values ($1, $2, 'langfuse', 'running', $3, clock_timestamp() + interval '5 minutes')
       on conflict (project_id, source) do update
         set status = 'running', run_token = excluded.run_token,
             lease_expires_at = excluded.lease_expires_at`,
      [`import_${ulid()}`, projectId, `run_${ulid()}`]
    );

    const result = await runLangfuseImport({
      pool,
      clickhouse,
      projectId,
      client: clientConfig(),
      pageSize: 10
    });
    expect(result).toBeNull();
  });

  it("marks the checkpoint 'error' and rethrows when the source API fails", async () => {
    const badConfig = { baseUrl: "http://localhost:1", publicKey: "pk", secretKey: "sk" };
    await expect(
      runLangfuseImport({ pool, clickhouse, projectId, client: badConfig, pageSize: 10 })
    ).rejects.toThrow();

    const checkpoint = await getImportCheckpoint(pool, projectId, "langfuse");
    expect(checkpoint?.status).toBe("error");
    expect(checkpoint?.lastError).toBeTruthy();
  });
});
