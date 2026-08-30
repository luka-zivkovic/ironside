import { createServer, type Server } from "node:http";
import { createClickHouseClient, runMigrations as runChMigrations } from "@ironside/clickhouse";
import {
  getEvaluatorTracePublications,
  getImportCheckpoint,
  listPendingEvaluatorImportTraceIds,
  runMigrations as runPgMigrations
} from "@ironside/db";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runLangsmithImport } from "../src/importers/langsmith-importer.js";
import { loadConfig } from "../src/config.js";

// Integration test against a real Postgres + ClickHouse (compose stack)
// and a minimal mock LangSmith HTTP server implementing cursor pagination
// the same way the real API does: a request's start_time filter re-scopes
// the WHOLE result set server-side, and cursor is an offset WITHIN that
// filtered set — so if the importer's startTime anchor drifted mid-run
// (the same bug class the LangFuse importer had), this test would catch it
// by requesting a page whose cursor no longer lines up with the filtered
// window, silently skipping or duplicating runs.

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);

let projectId: string;
let server: Server;
let serverUrl: string;
let requestLog: { startTime: string | null; cursor: string | null }[] = [];

let fixtureRuns: { id: string; start_time: string; name: string; trace_id?: string }[] = [];
let pageSize = 2;
/** Per-trace-id full run tree (root + children) served by the trace-scoped runs/query call. Traces without an entry return just the root run (matching fixtureRuns), same as a real trace with no child runs. */
let fixtureTraceRuns: Record<string, unknown[]> = {};
/** Per-run-id feedback served by GET /api/v1/feedback?run=... — keyed by run id, values merged across every requested run id. */
let fixtureFeedback: Record<string, unknown[]> = {};

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  const orgId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "langsmith-importer-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, "langsmith-importer-test"]
  );

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("content-type", "application/json");

    // GET /api/v1/feedback?run=...&run=... (repeatable param)
    if (req.method === "GET" && url.pathname === "/api/v1/feedback") {
      const runIds = url.searchParams.getAll("run");
      const seen = new Set<string>();
      const merged: unknown[] = [];
      for (const runId of runIds) {
        for (const fb of fixtureFeedback[runId] ?? []) {
          const id = (fb as { id: string }).id;
          if (!seen.has(id)) {
            seen.add(id);
            merged.push(fb);
          }
        }
      }
      res.end(JSON.stringify(merged));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { start_time?: string; cursor?: string; trace?: string };

      // Trace-scoped runs/query (the full-tree fetch) — unpaginated,
      // matching the API's own documented "trace" filter behavior.
      if (parsed.trace) {
        const runs = fixtureTraceRuns[parsed.trace] ?? fixtureRuns.filter((r) => (r.trace_id ?? r.id) === parsed.trace);
        res.end(JSON.stringify({ runs, cursors: { next: null } }));
        return;
      }

      requestLog.push({ startTime: parsed.start_time ?? null, cursor: parsed.cursor ?? null });

      const filtered = parsed.start_time
        ? fixtureRuns.filter((r) => r.start_time >= parsed.start_time!)
        : fixtureRuns;
      // Cursor encodes an offset WITHIN the filtered set, exactly like a
      // real opaque-but-consistent cursor would — if start_time changes
      // between requests within the same run, this offset silently means
      // something different than the caller expects.
      const offset = parsed.cursor ? Number(parsed.cursor.replace("offset:", "")) : 0;
      const page = filtered.slice(offset, offset + pageSize);
      const nextOffset = offset + pageSize;
      const hasMore = nextOffset < filtered.length;

      res.end(
        JSON.stringify({
          runs: page,
          cursors: hasMore ? { next: `offset:${nextOffset}` } : { next: null }
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address && typeof address === "object") {
    serverUrl = `http://localhost:${address.port}`;
  }
});

beforeEach(() => {
  requestLog = [];
  fixtureTraceRuns = {};
  fixtureFeedback = {};
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'langsmith-importer-test-org'");
  await pool.end();
  await clickhouse.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await pool.query(
    "delete from import_checkpoints where project_id = $1 and source = 'langsmith'",
    [projectId]
  );
});

function clientConfig() {
  return { baseUrl: serverUrl, apiKey: "ls_test" };
}

describe("runLangsmithImport", () => {
  it("imports all runs across multiple cursor pages and clears the cursor on exhaustion", async () => {
    fixtureRuns = Array.from({ length: 5 }, (_, i) => ({
      id: `run_${ulid()}`,
      start_time: `2026-07-12T00:00:0${i}.000Z`,
      name: `run-${i}`
    }));

    const result = await runLangsmithImport({
      pool,
      clickhouse,
      projectId,
      client: clientConfig(),
      sessionIds: ["sess_1"],
      pageSize: 2
    });

    expect(result?.imported).toBe(5);
    expect(result?.resumable).toBe(false);

    const checkpoint = await getImportCheckpoint(pool, projectId, "langsmith");
    expect(checkpoint?.status).toBe("idle");
    expect(checkpoint?.importedCount).toBe(5);
    expect(checkpoint?.checkpoint.cursor).toBeUndefined();
    expect(checkpoint?.checkpoint.lastStartTime).toBe("2026-07-12T00:00:04.000Z");

    const ids = fixtureRuns.map((r) => r.id);
    const rows = await clickhouse.query({
      query: `select id from traces final where project_id = {projectId:String} and id in ({ids:Array(String)})`,
      query_params: { projectId, ids },
      format: "JSONEachRow"
    });
    expect((await rows.json()).length).toBe(5);
  });

  it("startTime stays fixed for the whole run — every page request uses the same start_time, not a drifting one", async () => {
    fixtureRuns = Array.from({ length: 6 }, (_, i) => ({
      id: `run_${ulid()}`,
      start_time: `2026-07-12T05:00:0${i}.000Z`,
      name: `run-${i}`
    }));

    await runLangsmithImport({
      pool,
      clickhouse,
      projectId,
      client: clientConfig(),
      sessionIds: ["sess_1"],
      pageSize: 2
    });

    // First page has no start_time filter (fresh checkpoint); every
    // subsequent page within the SAME run must still show the same
    // (absent) start_time — not the just-recorded lastStartTime from page 1.
    expect(requestLog).toHaveLength(3);
    expect(requestLog.every((r) => r.startTime === null)).toBe(true);
  });

  it("resumes from the saved checkpoint (lastStartTime) on the next run, not from scratch", async () => {
    fixtureRuns = Array.from({ length: 3 }, (_, i) => ({
      id: `run_${ulid()}`,
      start_time: `2026-07-12T01:00:0${i}.000Z`,
      name: `run-${i}`
    }));

    await runLangsmithImport({
      pool,
      clickhouse,
      projectId,
      client: clientConfig(),
      sessionIds: ["sess_1"],
      pageSize: 10
    });
    requestLog = [];

    const newer = { id: `run_${ulid()}`, start_time: "2026-07-12T01:00:05.000Z", name: "new" };
    fixtureRuns.push(newer);

    await runLangsmithImport({
      pool,
      clickhouse,
      projectId,
      client: clientConfig(),
      sessionIds: ["sess_1"],
      pageSize: 10
    });

    expect(requestLog[0]?.startTime).toBe("2026-07-12T01:00:02.000Z");

    const rows = await clickhouse.query({
      query: `select id from traces final where project_id = {projectId:String} and id = {id:String}`,
      query_params: { projectId, id: newer.id },
      format: "JSONEachRow"
    });
    expect((await rows.json()).length).toBe(1);
  });

  it("stops after maxPagesPerRun and reports resumable=true, preserving the cursor", async () => {
    fixtureRuns = Array.from({ length: 6 }, (_, i) => ({
      id: `run_${ulid()}`,
      start_time: `2026-07-12T02:00:0${i}.000Z`,
      name: `run-${i}`
    }));

    const result = await runLangsmithImport({
      pool,
      clickhouse,
      projectId,
      client: clientConfig(),
      sessionIds: ["sess_1"],
      pageSize: 2,
      maxPagesPerRun: 1
    });

    expect(result?.resumable).toBe(true);
    expect(result?.imported).toBe(2);
    const checkpoint = await getImportCheckpoint(pool, projectId, "langsmith");
    expect(checkpoint?.status).toBe("idle");
    expect(checkpoint?.checkpoint.cursor).toBe("offset:2"); // not cleared — more pages remain
  });

  it("imports the FULL tree: child runs as observations (typed, usage/cost parsed from decimal strings) and feedback as scores on root AND child runs", async () => {
    const rootId = `run_${ulid()}`;
    const childId = `run_${ulid()}`;
    const rootFeedbackId = `fb_${ulid()}`;
    const childFeedbackId = `fb_${ulid()}`;
    fixtureRuns = [{ id: rootId, start_time: "2026-07-12T07:00:00.000Z", name: "full-data-root" }];
    fixtureTraceRuns[rootId] = [
      { id: rootId, trace_id: rootId, run_type: "chain", name: "full-data-root", start_time: "2026-07-12T07:00:00.000Z", end_time: "2026-07-12T07:00:02.000Z" },
      {
        id: childId,
        trace_id: rootId,
        parent_run_id: rootId,
        run_type: "llm",
        name: "llm-call",
        start_time: "2026-07-12T07:00:00.500Z",
        end_time: "2026-07-12T07:00:01.500Z",
        status: "error",
        error: "rate limited",
        inputs: { messages: [{ role: "user", content: "hi" }] },
        outputs: null,
        prompt_tokens: 12,
        completion_tokens: 0,
        total_tokens: 12,
        prompt_cost: "0.0006",
        completion_cost: "0.0000",
        total_cost: "0.0006"
      }
    ];
    fixtureFeedback[rootId] = [
      { id: rootFeedbackId, run_id: rootId, trace_id: rootId, key: "overall-quality", score: 1, created_at: "2026-07-10T00:00:00.000Z" }
    ];
    fixtureFeedback[childId] = [
      { id: childFeedbackId, run_id: childId, trace_id: rootId, key: "helpfulness", score: 0, comment: "rate limited, unhelpful", created_at: "2026-07-10T00:00:01.000Z" }
    ];

    const result = await runLangsmithImport({
      pool, clickhouse, projectId, client: clientConfig(), sessionIds: ["sess_1"], pageSize: 10
    });
    expect(result?.imported).toBe(1);

    const obsRows = await clickhouse.query({
      query: `select id, type, level, status_message, usage_details, cost_details, input, output from observations final where project_id = {projectId:String} and trace_id = {traceId:String}`,
      query_params: { projectId, traceId: rootId },
      format: "JSONEachRow"
    });
    const observations = (await obsRows.json()) as {
      id: string; type: string; level: string; status_message: string | null;
      usage_details: Record<string, string | number>; cost_details: Record<string, string | number>;
      input: string | null; output: string | null;
    }[];
    // Only the CHILD run becomes an observation — the root run is the
    // Trace, and the trace-scoped query's own copy of the root is
    // deduped out, not double-imported.
    expect(observations).toHaveLength(1);
    const child = observations[0]!;
    expect(child.id).toBe(childId);
    expect(child.type).toBe("generation"); // run_type "llm"
    expect(child.level).toBe("error"); // status: "error"
    expect(child.status_message).toBe("rate limited");
    expect(Number(child.usage_details.input_tokens)).toBe(12);
    expect(Number(child.usage_details.total_tokens)).toBe(12);
    expect(Number(child.cost_details.total)).toBeCloseTo(0.0006);
    expect(child.input).not.toBeNull();
    // outputs: null is an explicit null LangSmith recorded — it must
    // survive as the JSON-encoded string "null" (a SQL-NULL column value
    // would instead mean "field absent", losing the fact it was recorded
    // as an explicit null) — same JSON.stringify(null) contract every
    // other input/output column in this codebase uses.
    expect(child.output).toBe("null");

    const scoreRows = await clickhouse.query({
      query: `select id, observation_id, name, value, comment, timestamp from scores final where project_id = {projectId:String} and trace_id = {traceId:String} order by name`,
      query_params: { projectId, traceId: rootId },
      format: "JSONEachRow"
    });
    const scores = (await scoreRows.json()) as {
      id: string; observation_id: string | null; name: string; value: number | null;
      comment: string | null; timestamp: string;
    }[];
    expect(scores).toHaveLength(2);

    const rootFeedback = scores.find((s) => s.name === "overall-quality")!;
    expect(rootFeedback.observation_id).toBeNull(); // feedback on the root run = trace-level, no observationId
    expect(rootFeedback.value).toBe(1);

    const childFeedback = scores.find((s) => s.name === "helpfulness")!;
    expect(childFeedback.observation_id).toBe(childId); // feedback on a CHILD run links to that observation
    expect(childFeedback.value).toBe(0); // value 0 must survive — meaningful data, not falsy noise
    expect(childFeedback.comment).toBe("rate limited, unhelpful");
    expect(childFeedback.timestamp.startsWith("2026-07-10")).toBe(true); // original feedback time, not import time
    const publication = (await getEvaluatorTracePublications(pool, projectId, [rootId]))
      .get(rootId);
    expect(publication).toBeDefined();
    expect((await listPendingEvaluatorImportTraceIds(pool, projectId, [rootId])).has(rootId))
      .toBe(false);
  });

  it("a concurrent call while a run is already 'running' returns null instead of racing the checkpoint", async () => {
    fixtureRuns = [{ id: `run_${ulid()}`, start_time: "2026-07-12T03:00:00.000Z", name: "x" }];

    await pool.query(
      `insert into import_checkpoints
         (id, project_id, source, status, run_token, lease_expires_at)
       values ($1, $2, 'langsmith', 'running', $3, clock_timestamp() + interval '5 minutes')
       on conflict (project_id, source) do update
         set status = 'running', run_token = excluded.run_token,
             lease_expires_at = excluded.lease_expires_at`,
      [`import_${ulid()}`, projectId, `run_${ulid()}`]
    );

    const result = await runLangsmithImport({
      pool,
      clickhouse,
      projectId,
      client: clientConfig(),
      sessionIds: ["sess_1"],
      pageSize: 10
    });
    expect(result).toBeNull();
  });

  it("marks the checkpoint 'error' and rethrows when the source API fails", async () => {
    const badConfig = { baseUrl: "http://localhost:1", apiKey: "ls_bad" };
    await expect(
      runLangsmithImport({
        pool,
        clickhouse,
        projectId,
        client: badConfig,
        sessionIds: ["sess_1"],
        pageSize: 10
      })
    ).rejects.toThrow();

    const checkpoint = await getImportCheckpoint(pool, projectId, "langsmith");
    expect(checkpoint?.status).toBe("error");
    expect(checkpoint?.lastError).toBeTruthy();
  });
});
