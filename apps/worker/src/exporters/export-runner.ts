import {
  getVersionedTraceSummaries,
  listScoresForTraces,
  type ClickHouseClient
} from "@ironside/clickhouse";
import {
  getEvaluatorTracePublications,
  listTraceScoreActivities,
  recordExportRun,
  type DestinationFeedCursor,
  type ExportConfig
} from "@ironside/db";
import { traceSettledBefore, type Score } from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import type { Pool } from "pg";
import { scoreFromStoredRow } from "../lib/stored-rows.js";
import { ExportStaging } from "./duckdb-writer.js";
import { loadExportedTraces, type ExportedTrace } from "./exported-traces.js";
import { readSettledTraceFeed } from "./settled-trace-feed.js";
import { matchesExportFilter } from "./trace-filter.js";

/** Traces loaded per feed page; bounds memory, since each carries its full observation tree. */
const FEED_PAGE_SIZE = 100;
/** Traces per run and per feed. A larger backlog continues on the next scheduler tick, so one run stays bounded in time and file size. */
const MAX_TRACES_PER_RUN = 10_000;
/** Feed entries examined per run and per feed, which bounds a run whose filter matches few traces. */
const MAX_FEED_ENTRIES_PER_RUN = 100_000;

export interface RunExportOptions {
  pool: Pool;
  clickhouse: ClickHouseClient;
  config: ExportConfig;
  /** Decrypted destination secret key — decrypting is the API layer's job (has the encryption secret); the worker only ever handles a config with this already resolved. */
  destinationSecretAccessKey: string;
  /** Project-effective quiet period used to exclude in-flight traces. */
  traceQuietPeriodSeconds: number;
}

export interface ExportRunResult {
  /** Traces exported in this run, counting traces whose scores alone were re-sent. */
  rowCount: number;
  objectKeys: string[];
}

interface PassResult {
  cursor: DestinationFeedCursor | null;
  exported: number;
  backlog: boolean;
}

/**
 * Runs one export (spec/scheduled-export-v1.md). The trace pass reads settled
 * trace versions published after the config's trace feed position and writes
 * each complete trace, observations and scores included. The score pass then
 * reads the score feed for traces whose scores changed without other
 * activity, which the trace feed deliberately ignores, and re-sends their
 * scores. Both positions advance only after the upload succeeds, so a failed
 * run sends the same data again: delivery is at-least-once, and consumers
 * keep the highest `trace_version` per trace and upsert scores by id. A run
 * with nothing new is a successful no-op.
 */
export async function runExport(options: RunExportOptions): Promise<ExportRunResult | null> {
  const { pool, config } = options;
  const staging = await ExportStaging.create(config.format);

  try {
    const traces = await exportTracePass(options, staging);
    const scores = await exportScorePass(options, staging);
    const exported = traces.exported + scores.exported;
    const recordPositions = {
      feedCursor: { from: config.feedCursor, to: traces.cursor },
      scoreFeedCursor: { from: config.scoreFeedCursor, to: scores.cursor },
      runAgainSoon: traces.backlog || scores.backlog
    };

    if (exported === 0) {
      await recordExportRun(pool, config.id, { status: "success", rowCount: 0, ...recordPositions });
      return null;
    }

    const runName = `export-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const files = await staging.finish(runName);
    const destination = createObjectStorage({
      endpoint: config.destinationEndpoint,
      region: config.destinationRegion,
      accessKeyId: config.destinationAccessKeyId,
      secretAccessKey: options.destinationSecretAccessKey,
      bucket: config.destinationBucket
    });
    const prefix =
      config.destinationPrefix && !config.destinationPrefix.endsWith("/")
        ? `${config.destinationPrefix}/`
        : config.destinationPrefix;
    const objectKeys: string[] = [];
    try {
      for (const file of files) {
        const objectKey = `${prefix}${file.name}`;
        await destination.putFile(objectKey, file.path, file.contentType);
        objectKeys.push(objectKey);
      }
    } finally {
      destination.close();
    }

    await recordExportRun(pool, config.id, { status: "success", rowCount: exported, ...recordPositions });
    return { rowCount: exported, objectKeys };
  } catch (error) {
    // Both feed positions are left where they were, so the next run retries.
    await recordExportRun(pool, config.id, {
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    }).catch(() => undefined);
    throw error;
  } finally {
    await staging.cleanup();
  }
}

async function exportTracePass(options: RunExportOptions, staging: ExportStaging): Promise<PassResult> {
  const { pool, clickhouse, config } = options;
  const settledBefore = traceSettledBefore(options.traceQuietPeriodSeconds);
  let cursor = config.feedCursor;
  let exported = 0;
  let examined = 0;
  for (;;) {
    const page = await readSettledTraceFeed(
      { pool, clickhouse },
      {
        projectId: config.projectId,
        cursor,
        settledBefore,
        limit: Math.min(FEED_PAGE_SIZE, MAX_TRACES_PER_RUN - exported)
      }
    );
    const wanted = page.entries.flatMap((entry) =>
      entry.trace && matchesExportFilter(entry.trace, config.filter) ? [entry.trace] : []
    );
    const loaded = await loadExportedTraces(
      clickhouse,
      config.projectId,
      wanted.map((trace) => trace.id)
    );

    const batch: ExportedTrace[] = [];
    let changedSinceRead = false;
    for (const entry of page.entries) {
      if (entry.trace && entry.version && matchesExportFilter(entry.trace, config.filter)) {
        const full = loaded.get(entry.trace.id);
        if (!full || full.activityVersion !== entry.trace.trace_version) {
          // Written or removed since the page was read. Stop before it: the
          // feed lists it again with its new version, or the next read
          // steps over it once removed.
          changedSinceRead = true;
          break;
        }
        batch.push({
          trace: full.trace,
          observations: full.observations,
          scores: full.scores,
          traceVersion: entry.version
        });
      }
      cursor = entry.cursor;
    }
    await staging.append(batch);
    exported += batch.length;
    examined += page.entries.length;

    if (changedSinceRead || page.blocked || !page.hasMore) return { cursor, exported, backlog: false };
    if (exported >= MAX_TRACES_PER_RUN || examined >= MAX_FEED_ENTRIES_PER_RUN) {
      return { cursor, exported, backlog: true };
    }
  }
}

/**
 * Re-sends the current scores of traces whose scores changed in batches with
 * no trace or observation activity. Scores are annotations, not trace
 * activity, so they are sent as soon as they are written rather than after a
 * quiet period. A trace not in ClickHouse yet is stepped over: its scores go
 * out with the trace itself when the trace pass reaches it.
 */
async function exportScorePass(options: RunExportOptions, staging: ExportStaging): Promise<PassResult> {
  const { pool, clickhouse, config } = options;
  let cursor = config.scoreFeedCursor;
  let exported = 0;
  let examined = 0;
  for (;;) {
    const page = await listTraceScoreActivities(pool, {
      projectId: config.projectId,
      cursor,
      limit: FEED_PAGE_SIZE + 1
    });
    const window = page.slice(0, FEED_PAGE_SIZE);
    if (window.length === 0) return { cursor, exported, backlog: false };
    const traceIds = window.map((entry) => entry.traceId);
    const [summaries, publications] = await Promise.all([
      getVersionedTraceSummaries(clickhouse, config.projectId, traceIds),
      getEvaluatorTracePublications(pool, config.projectId, traceIds)
    ]);
    const matching = traceIds.filter((traceId) => {
      const summary = summaries.get(traceId);
      return summary !== undefined && matchesExportFilter(summary, config.filter);
    });
    const scoresByTrace = new Map<string, Score[]>();
    for (const row of await listScoresForTraces(clickhouse, config.projectId, matching)) {
      const scores = scoresByTrace.get(row.trace_id) ?? [];
      scores.push(scoreFromStoredRow(config.projectId, row));
      scoresByTrace.set(row.trace_id, scores);
    }
    await staging.appendScores(
      matching.map((traceId) => ({
        scores: scoresByTrace.get(traceId) ?? [],
        traceVersion: publications.get(traceId)?.traceVersion ?? summaries.get(traceId)!.trace_version
      }))
    );
    exported += matching.length;
    examined += window.length;
    cursor = window.at(-1)!;

    if (page.length <= FEED_PAGE_SIZE) return { cursor, exported, backlog: false };
    if (exported >= MAX_TRACES_PER_RUN || examined >= MAX_FEED_ENTRIES_PER_RUN) {
      return { cursor, exported, backlog: true };
    }
  }
}
