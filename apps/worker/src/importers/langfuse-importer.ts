import type { ClickHouseClient } from "@ironside/clickhouse";
import {
  claimImportRun,
  getImportCheckpoint,
  markImportRunFailed,
  markImportRunIdle,
  renewImportRunLease,
  stageEvaluatorImportTraces,
  saveImportProgress
} from "@ironside/db";
import { ulid } from "ulid";
import type { Pool } from "pg";
import type { Trace } from "@ironside/shared";
import { LangfuseClient, type LangfuseClientConfig, type LangfuseListTrace } from "./langfuse-client.js";
import { mapLangfuseObservation, mapLangfuseScore, mapLangfuseTraceDetail } from "./langfuse-mapper.js";
import {
  importedTraceContentHash,
  importedEvaluatorTraceContentHash,
  importedTraceSnapshot,
  recoverPendingEvaluatorImportSnapshots
} from "./evaluator-publication.js";

interface LangfuseCheckpointShape {
  [key: string]: unknown;
  /** ISO 8601 timestamp of the last successfully-imported trace; resumes via fromTimestamp on interrupt. */
  lastTimestamp?: string;
  /** Page within the current fromTimestamp window — LangFuse's API has no cursor token, only page/limit. */
  page: number;
}

export interface RunLangfuseImportOptions {
  pool: Pool;
  clickhouse: ClickHouseClient;
  projectId: string;
  client: LangfuseClientConfig;
  pageSize?: number;
  /** Safety cap on pages per invocation, so one call can't run unbounded against a huge account. Resumes on the next call via the saved checkpoint. */
  maxPagesPerRun?: number;
  onEnvironmentRegistryOverflow?: (count: number) => void;
  /** Invalid provider rows are skipped so one poison trace cannot pin the source checkpoint. */
  onInvalidTrace?: (traceId: string, error: unknown) => void;
}

export interface LangfuseImportResult {
  imported: number;
  /** true if the loop stopped due to maxPagesPerRun, not because the source was exhausted — call again to continue. */
  resumable: boolean;
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES_PER_RUN = 20;

/**
 * Pull-based backfill: pages through LangFuse's trace list API oldest-first
 * (orderBy=timestamp.asc), maps each trace to Ironside's domain model, and
 * batch-inserts into ClickHouse. Progress is checkpointed to Postgres after
 * every page — an interrupted run (process kill, crash, deploy) resumes
 * from the last completed page's timestamp+page rather than restarting the
 * whole backfill or silently skipping the gap.
 *
 * Concurrency: claimImportRun makes concurrent invocations for the same
 * (projectId, "langfuse") a no-op (returns null, caller should skip) rather
 * than racing two backfills against the same checkpoint.
 */
export async function runLangfuseImport(
  options: RunLangfuseImportOptions
): Promise<LangfuseImportResult | null> {
  const { pool, clickhouse, projectId } = options;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPagesPerRun ?? DEFAULT_MAX_PAGES_PER_RUN;

  const claimed = await claimImportRun(pool, projectId, "langfuse", `import_${ulid()}`);
  if (!claimed) return null; // another run is already in progress
  const runToken = claimed.runToken!;

  const existing = await getImportCheckpoint(pool, projectId, "langfuse");
  const checkpoint: LangfuseCheckpointShape = {
    page: 1,
    ...(existing?.checkpoint as LangfuseCheckpointShape | undefined)
  };

  const client = new LangfuseClient(options.client);
  let totalImported = 0;
  let resumable = false;
  // Fixed for the whole run: fromTimestamp anchors a query window server-side
  // (LangFuse filters+re-paginates against it), so if it changed mid-run
  // every subsequent page() would be an offset into a DIFFERENT filtered
  // result set than the one page 1 was counted against — silently skipping
  // or duplicating traces. Only the NEXT run's starting fromTimestamp should
  // advance (via checkpoint.lastTimestamp), not this run's in-flight window.
  const fromTimestampForThisRun = checkpoint.lastTimestamp;
  // Each staged trace generation below receives a stable event_ts. That makes
  // retries idempotent while still letting an A→B→A source reversion allocate
  // a newer generation than B.
  // The checkpoint invariant: `checkpoint.page` is the next page to fetch
  // within the window anchored at `checkpoint.lastTimestamp`. The two
  // fields must ALWAYS be saved consistently with each other. An earlier
  // version advanced lastTimestamp after every page while also saving the
  // incremented page number — internally inconsistent, because page N was
  // counted against the window anchored at the RUN-START timestamp, but
  // the next run re-anchors its window at the newly-saved (later)
  // lastTimestamp, which renumbers every page. Concretely, against a real
  // 51-trace LangFuse account with pageSize=10/maxPagesPerRun=3: run 1
  // imported 30 and saved {lastTimestamp: T30, page: 4}; run 2 queried
  // page 4 of the [T30, ∞) window — which only has ~3 pages — got an
  // empty page, and falsely concluded the source was exhausted, silently
  // leaving 21 traces unimported (and a mid-run crash could similarly
  // SKIP traces on resume, since page 4 of the re-anchored window lands
  // beyond unfetched data). Caught by the M5 conformance run against the
  // real account — the fixture test asserted the checkpoint's shape after
  // a capped run but never actually resumed and asserted completion.
  let newestSeenTimestamp: string | undefined;

  try {
    await recoverPendingEvaluatorImportSnapshots({
      pool,
      clickhouse,
      projectId,
      source: "langfuse",
      runToken,
      onEnvironmentRegistryOverflow: options.onEnvironmentRegistryOverflow
    });
    for (let pagesFetched = 0; pagesFetched < maxPages; pagesFetched++) {
      await renewImportRunLease(pool, projectId, "langfuse", runToken);
      const response = await client.listTraces({
        page: checkpoint.page,
        limit: pageSize,
        ...(fromTimestampForThisRun && { fromTimestamp: fromTimestampForThisRun })
      });

      let pageImported = 0;
      if (response.data.length > 0) {
        // Full-data import: the list response only carries trace-level
        // fields, so each trace's detail (observations + scores +
        // detail-only fields like environment) is fetched individually —
        // one extra request per trace, the only way LangFuse's public
        // API exposes the tree. A failed detail fetch fails the whole
        // run BEFORE this page's checkpoint save, so a retry re-fetches
        // the page and its details idempotently (ReplacingMergeTree
        // dedups re-inserts) — no partial page is ever recorded as done.
        const traces: Trace[] = [];
        const candidateActivityAt = new Date().toISOString();
        const snapshots = new Map<string, ReturnType<typeof importedTraceSnapshot>>();
        for (const listTrace of response.data as LangfuseListTrace[]) {
          await renewImportRunLease(pool, projectId, "langfuse", runToken);
          const detail = await client.getTraceDetail(listTrace.id);
          try {
            const trace = mapLangfuseTraceDetail(projectId, detail);
            const traceObservations = detail.observations.map((observation) =>
              mapLangfuseObservation(projectId, detail.id, observation)
            );
            // Scores are annotations, not part of evaluator-visible trace
            // identity. Filter malformed/valueless provider feedback per row
            // so one unusable annotation cannot permanently skip an otherwise
            // valid trace tree when the page checkpoint advances.
            const traceScores = detail.scores.flatMap((score) => {
              const mapped = mapLangfuseScore(projectId, score);
              return mapped ? [mapped] : [];
            });
            const snapshot = importedTraceSnapshot(
              trace,
              traceObservations,
              traceScores
            );
            traces.push(snapshot.trace);
            snapshots.set(snapshot.trace.id, snapshot);
          } catch (error) {
            (options.onInvalidTrace ?? ((traceId, cause) =>
              console.error(`[import:langfuse] skipping invalid trace ${traceId}`, cause)
            ))(listTrace.id, error);
          }
        }
        const staged = await stageEvaluatorImportTraces(pool, {
          projectId,
          source: "langfuse",
          runToken,
          candidateActivityId: `import_langfuse_${ulid()}`,
          candidateActivityAt,
          traces: traces.map((trace) => ({
            traceId: trace.id,
            contentHash: importedTraceContentHash(
              trace,
              snapshots.get(trace.id)!.observations,
              snapshots.get(trace.id)!.scores
            ),
            evaluatorContentHash: importedEvaluatorTraceContentHash(
              trace,
              snapshots.get(trace.id)!.observations
            ),
            snapshot: snapshots.get(trace.id)!
          }))
        });
        if (staged.size !== traces.length) throw new Error("missing staged Langfuse traces");
        await recoverPendingEvaluatorImportSnapshots({
          pool,
          clickhouse,
          projectId,
          source: "langfuse",
          runToken,
          onEnvironmentRegistryOverflow: options.onEnvironmentRegistryOverflow
        });
        pageImported = traces.length;
        totalImported += pageImported;
        // Oldest-first within a page too (orderBy=timestamp.asc server-side),
        // so the last element is the newest timestamp seen so far.
        const lastInPage = response.data.at(-1)?.timestamp;
        if (lastInPage) newestSeenTimestamp = lastInPage;
      }

      const isLastPage = checkpoint.page >= response.meta.totalPages || response.data.length === 0;
      if (isLastPage) {
        // Exhausted this fromTimestamp window. Only NOW does the anchor
        // advance: reset to page 1 of the window starting at the newest
        // trace seen, so the next invocation re-queries from there
        // (catching anything created after this run started) instead of
        // requesting an empty page 2 forever. Re-fetching the boundary
        // trace — or the whole GROUP of traces sharing that exact
        // timestamp, if several tie at the tail — is a deliberate no-op
        // (fromTimestamp is inclusive; ReplacingMergeTree dedups the
        // re-inserts). If a tied group sits at the true end of the
        // dataset, every future invocation re-fetches that group until
        // newer data arrives — accepted as harmless-but-repeated cost
        // rather than adding a tie-breaker; see
        // spec/langfuse-importer-v1.md's limitations.
        if (newestSeenTimestamp) checkpoint.lastTimestamp = newestSeenTimestamp;
        checkpoint.page = 1;
        await saveImportProgress(pool, projectId, "langfuse", runToken, checkpoint, pageImported);
        break;
      }

      // Mid-window: advance ONLY the page, keeping the anchor untouched —
      // checkpoint.lastTimestamp still holds the anchor this page count
      // is relative to, so a resume (next call, or crash recovery)
      // continues at exactly this window position.
      checkpoint.page += 1;
      await saveImportProgress(pool, projectId, "langfuse", runToken, checkpoint, pageImported);

      if (pagesFetched === maxPages - 1) resumable = true;
    }

    await markImportRunIdle(pool, projectId, "langfuse", runToken);
    return { imported: totalImported, resumable };
  } catch (error) {
    await markImportRunFailed(
      pool,
      projectId,
      "langfuse",
      runToken,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}
