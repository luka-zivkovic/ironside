import {
  createClickHouseClient,
  getAggregates,
  insertObservations,
  insertTraces,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import { mapLangfuseIngestionRequest } from "@ironside/mappers";
import type { Observation, Trace } from "@ironside/shared";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { mapLangsmithObservation } from "../src/importers/langsmith-mapper.js";

// The M9-04 money test: token aggregates from DIFFERENT sources must sum
// under ONE key vocabulary. Before this batch, the LangSmith importer
// wrote input/output/total while the SDK/OTLP/LangFuse-compat family
// wrote input_tokens/output_tokens — so a project mixing sources got two
// disjoint token series that sumMap could never merge (flagged in
// spec/direct-ingest-primacy-v1.md, deliberately deferred until now).
// This test runs the REAL mappers (not hand-shaped rows) through real
// ClickHouse and asserts the aggregate comes back unified.

const config = loadConfig();
const clickhouse = createClickHouseClient(config.clickhouse);

const projectId = `proj_${ulid()}`;

beforeAll(async () => {
  await runChMigrations(clickhouse);
});

afterAll(async () => {
  await clickhouse.close();
});

describe("cross-source usage-key unification (M9-04)", () => {
  it("a LangSmith-imported observation and a LangFuse-compat observation sum under the same token keys in getAggregates", async () => {
    const marker = `usage_unify_${ulid()}`;
    const eventTs = new Date().toISOString();

    // Source 1: the REAL LangSmith importer mapper, from a wire-shaped run
    // (tokens as numbers, costs as decimal strings).
    const langsmithTraceId = `trace_ls_${marker}`;
    const langsmithObservation = mapLangsmithObservation(projectId, langsmithTraceId, {
      id: `run_${marker}`,
      run_type: "llm",
      start_time: "2026-07-12T00:00:00.000Z",
      end_time: "2026-07-12T00:00:01.000Z",
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150
    });

    // Source 2: the REAL LangFuse compat mapper, from an SDK batch using
    // the legacy {input, output, total} usage shape.
    const { rows } = mapLangfuseIngestionRequest(projectId, {
      batch: [
        {
          id: `evt_${marker}`,
          timestamp: eventTs,
          type: "generation-create",
          body: {
            id: `gen_${marker}`,
            traceId: `trace_lf_${marker}`,
            startTime: "2026-07-12T00:00:00.000Z",
            endTime: "2026-07-12T00:00:01.000Z",
            usage: { input: 30, output: 20, total: 50 }
          }
        }
      ]
    });
    expect(rows.observations).toHaveLength(1);

    const traces: Trace[] = [
      { id: langsmithTraceId, projectId, timestamp: eventTs, tags: [marker], metadata: {} },
      { id: `trace_lf_${marker}`, projectId, timestamp: eventTs, tags: [marker], metadata: {} }
    ];
    const observations: Observation[] = [langsmithObservation, rows.observations[0]!];

    await insertTraces(clickhouse, traces, { eventTs });
    await insertObservations(clickhouse, observations, { eventTs });

    const aggregates = await getAggregates(clickhouse, { projectId, tags: [marker] });

    // ONE vocabulary: both sources' tokens under the canonical keys, no
    // stray `input`/`output`/`total` series splitting the sums.
    expect(aggregates.token_totals).toEqual({
      input_tokens: 130,
      output_tokens: 70,
      total_tokens: 200
    });
  });
});
