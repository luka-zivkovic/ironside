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
import { LangsmithClient, type LangsmithClientConfig, type LangsmithRun } from "./langsmith-client.js";
import { mapLangsmithFeedback, mapLangsmithObservation, mapLangsmithRun } from "./langsmith-mapper.js";
import {
  importedTraceContentHash,
  importedEvaluatorTraceContentHash,
  importedTraceSnapshot,
  recoverPendingEvaluatorImportSnapshots
} from "./evaluator-publication.js";

interface LangsmithCheckpointShape {
  [key: string]: unknown;
  /** Opaque LangSmith cursor for the next page within the current backfill window; absent = start of a window. */
  cursor?: string;
  /** ISO 8601 start_time of the last successfully-imported run; anchors the NEXT run's window (see runLangsmithImport's fixed-per-run comment). */
  lastStartTime?: string;
}

export interface RunLangsmithImportOptions {
  pool: Pool;
  clickhouse: ClickHouseClient;
  projectId: string;
  client: LangsmithClientConfig;
  /** LangSmith "session" (project) UUIDs to import from. */
  sessionIds: string[];
  pageSize?: number;
  /** Safety cap on pages per invocation; resumes on the next call via the saved checkpoint. */
  maxPagesPerRun?: number;
  /** Invalid provider rows are skipped so one poison trace cannot pin the source checkpoint. */
  onInvalidTrace?: (traceId: string, error: unknown) => void;
}

export interface LangsmithImportResult {
  imported: number;
  /** true if the loop stopped due to maxPagesPerRun, not because the source was exhausted — call again to continue. */
  resumable: boolean;
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES_PER_RUN = 20;

/**
 * Pull-based backfill: pages through LangSmith's runs/query API oldest-first
 * (order: "asc", is_root: true so only trace-level runs are imported), maps
 * each run to Ironside's domain model, and batch-inserts into ClickHouse.
 * Same checkpoint/resume/concurrency-guard design as runLangfuseImport
 * (apps/worker/src/importers/langfuse-importer.ts) — see that file's doc
 * comment for the shared rationale. Two things differ because the source
 * APIs paginate completely differently:
 * - LangSmith uses opaque cursor tokens (cursors.next), not page numbers —
 *   there's no equivalent of "page >= totalPages" to detect exhaustion;
 *   exhaustion is signaled by cursors.next being absent/null.
 * - startTime (the window anchor, LangSmith's start_time filter) must stay
 *   fixed for the whole run for the same reason LangFuse's fromTimestamp
 *   does: the source re-evaluates it server-side per request, so a moving
 *   window would desync from the cursor's position within it.
 */
export async function runLangsmithImport(
  options: RunLangsmithImportOptions
): Promise<LangsmithImportResult | null> {
  const { pool, clickhouse, projectId } = options;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPagesPerRun ?? DEFAULT_MAX_PAGES_PER_RUN;

  const claimed = await claimImportRun(pool, projectId, "langsmith", `import_${ulid()}`);
  if (!claimed) return null; // another run is already in progress
  const runToken = claimed.runToken!;

  const existing = await getImportCheckpoint(pool, projectId, "langsmith");
  const checkpoint: LangsmithCheckpointShape = {
    ...(existing?.checkpoint as LangsmithCheckpointShape | undefined)
  };
  const startTimeForThisRun = checkpoint.lastStartTime;
  const client = new LangsmithClient(options.client);
  let totalImported = 0;
  let resumable = false;
  let newestSeenStartTime: string | undefined;

  try {
    await recoverPendingEvaluatorImportSnapshots({
      pool,
      clickhouse,
      projectId,
      source: "langsmith",
      runToken
    });
    for (let pagesFetched = 0; pagesFetched < maxPages; pagesFetched++) {
      await renewImportRunLease(pool, projectId, "langsmith", runToken);
      const response = await client.queryRuns({
        sessionIds: options.sessionIds,
        limit: pageSize,
        ...(checkpoint.cursor && { cursor: checkpoint.cursor }),
        ...(startTimeForThisRun && { startTime: startTimeForThisRun })
      });

      let pageImported = 0;
      if (response.runs.length > 0) {
        // Full-data import: root runs paginate/checkpoint the backfill
        // (proven resumable), but each root run's FULL tree (every
        // descendant run) and feedback are fetched separately — one
        // extra runs/query (trace-scoped, unpaginated per the API's own
        // documented behavior) plus one feedback query per trace. A
        // failure here fails the whole run BEFORE this page's checkpoint
        // save, same contract as the LangFuse importer: a retry re-fetches
        // the page and its trees idempotently, no partial page is ever
        // recorded as done.
        const traces: Trace[] = [];
        const candidateActivityAt = new Date().toISOString();
        const snapshots = new Map<string, ReturnType<typeof importedTraceSnapshot>>();
        for (const rootRun of response.runs as LangsmithRun[]) {
          await renewImportRunLease(pool, projectId, "langsmith", runToken);
          const traceId = rootRun.trace_id ?? rootRun.id;
          const treeRuns = await client.getTraceRuns(traceId);
          // The trace-scoped query returns the root run again — dedup by
          // id so it isn't mapped as both a Trace and an Observation.
          const childRuns = treeRuns.filter((r) => r.id !== rootRun.id);
          const allRunIds = [rootRun.id, ...childRuns.map((r) => r.id)];
          const feedback = await client.getFeedbackForRuns(allRunIds);
          try {
            const trace = mapLangsmithRun(projectId, rootRun);
            const traceObservations = childRuns.map((child) =>
              mapLangsmithObservation(projectId, traceId, child)
            );
            const traceScores = feedback.flatMap((entry) => {
              const score = mapLangsmithFeedback(projectId, traceId, entry);
              return score ? [score] : [];
            });
            const snapshot = importedTraceSnapshot(
              trace,
              traceObservations,
              traceScores
            );
            traces.push(snapshot.trace);
            snapshots.set(snapshot.trace.id, snapshot);
          } catch (error) {
            (options.onInvalidTrace ?? ((id, cause) =>
              console.error(`[import:langsmith] skipping invalid trace ${id}`, cause)
            ))(traceId, error);
          }
        }
        const staged = await stageEvaluatorImportTraces(pool, {
          projectId,
          source: "langsmith",
          runToken,
          candidateActivityId: `import_langsmith_${ulid()}`,
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
        if (staged.size !== traces.length) throw new Error("missing staged LangSmith traces");
        await recoverPendingEvaluatorImportSnapshots({
          pool,
          clickhouse,
          projectId,
          source: "langsmith",
          runToken
        });
        pageImported = traces.length;
        totalImported += pageImported;
        // order: "asc" server-side, so the last element is the newest
        // start_time seen so far in this run. Do not persist it alongside an
        // in-window cursor: that opaque cursor was minted against the fixed
        // startTimeForThisRun filter and changes meaning if the filter moves.
        const lastStartTime = response.runs.at(-1)?.start_time;
        if (lastStartTime) newestSeenStartTime = lastStartTime;
      }

      const nextCursor = response.cursors?.next;
      const isExhausted = !nextCursor || response.runs.length === 0;
      if (isExhausted) {
        // Window exhausted. Clear the cursor so the NEXT invocation starts
        // a fresh window from lastStartTime forward, rather than resending
        // a stale/expired cursor from a completed window.
        delete checkpoint.cursor;
        if (newestSeenStartTime) checkpoint.lastStartTime = newestSeenStartTime;
        await saveImportProgress(pool, projectId, "langsmith", runToken, checkpoint, pageImported);
        break;
      }

      checkpoint.cursor = nextCursor;
      await saveImportProgress(pool, projectId, "langsmith", runToken, checkpoint, pageImported);

      if (pagesFetched === maxPages - 1) resumable = true;
    }

    await markImportRunIdle(pool, projectId, "langsmith", runToken);
    return { imported: totalImported, resumable };
  } catch (error) {
    await markImportRunFailed(
      pool,
      projectId,
      "langsmith",
      runToken,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}
