import type { ClickHouseClient } from "@ironside/clickhouse";
import { recordExportRun, type ExportConfig } from "@ironside/db";
import { traceSettledBefore } from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import type { Pool } from "pg";
import { ExportStaging } from "./duckdb-writer.js";
import { loadExportedTraces, type ExportedTrace } from "./exported-traces.js";
import { readSettledTraceFeed } from "./settled-trace-feed.js";
import { matchesExportFilter } from "./trace-filter.js";

/** Traces loaded per feed page; bounds memory, since each carries its full observation tree. */
const FEED_PAGE_SIZE = 100;
/** Traces per run. A larger backlog continues on the next scheduler tick, so one run stays bounded in time and file size. */
const MAX_TRACES_PER_RUN = 10_000;
/** Feed entries examined per run, which bounds a run whose filter matches few traces. */
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
  /** Traces exported in this run. */
  rowCount: number;
  objectKeys: string[];
}

/**
 * Runs one export: reads settled trace versions published after the config's
 * feed position, writes each complete trace (observations and scores
 * included) to a Parquet or JSONL file set, uploads it, then records the new
 * position (spec/scheduled-export-v1.md). The position only advances after
 * the upload succeeds, so a failed run sends the same traces again: delivery
 * is at-least-once, and consumers keep the newest `trace_version` per id.
 * A run with nothing new is a successful no-op.
 */
export async function runExport(options: RunExportOptions): Promise<ExportRunResult | null> {
  const { pool, clickhouse, config } = options;
  const settledBefore = traceSettledBefore(options.traceQuietPeriodSeconds);
  const staging = await ExportStaging.create(config.format);

  try {
    let cursor = config.feedCursor;
    let exported = 0;
    let examined = 0;
    let backlog = false;
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
        if (entry.trace && matchesExportFilter(entry.trace, config.filter)) {
          const full = loaded.get(entry.trace.id);
          if (!full || full.traceVersion !== entry.trace.trace_version) {
            // Written or removed since the page was read. Stop before it: the
            // feed lists it again with its new version, or the next read
            // steps over it once removed.
            changedSinceRead = true;
            break;
          }
          batch.push(full);
        }
        cursor = entry.cursor;
      }
      await staging.append(batch);
      exported += batch.length;
      examined += page.entries.length;

      if (changedSinceRead || page.blocked || !page.hasMore) break;
      if (exported >= MAX_TRACES_PER_RUN || examined >= MAX_FEED_ENTRIES_PER_RUN) {
        backlog = true;
        break;
      }
    }

    if (exported === 0) {
      await recordExportRun(pool, config.id, {
        status: "success",
        rowCount: 0,
        feedCursor: cursor,
        runAgainSoon: backlog
      });
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

    await recordExportRun(pool, config.id, {
      status: "success",
      rowCount: exported,
      feedCursor: cursor,
      runAgainSoon: backlog
    });
    return { rowCount: exported, objectKeys };
  } catch (error) {
    // The feed position is left where it was, so the next run retries these traces.
    await recordExportRun(pool, config.id, {
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    }).catch(() => undefined);
    throw error;
  } finally {
    await staging.cleanup();
  }
}
