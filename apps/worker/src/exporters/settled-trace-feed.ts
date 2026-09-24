import {
  getVersionedTraceSummaries,
  listPendingTraceRawRefIds,
  type ClickHouseClient,
  type VersionedTraceSummaryRow
} from "@ironside/clickhouse";
import {
  listEvaluatorTraceActivities,
  listPendingEvaluatorImportTraceIds,
  type DestinationFeedCursor
} from "@ironside/db";
import type { Pool } from "pg";

export interface SettledFeedEntry {
  /** Feed position of this entry; a destination that accepted it resumes after here. */
  cursor: DestinationFeedCursor;
  /** The settled trace to send, or absent when retention removed it after it was published. */
  trace?: VersionedTraceSummaryRow;
  /**
   * The feed's version for this publication: distinct and increasing for
   * every publication of the trace, unlike `trace.trace_version` (its latest
   * activity time), which a late batch with an older receive time leaves
   * unchanged. Destinations order snapshots by this.
   */
  version?: string;
}

export interface SettledFeedPage {
  entries: SettledFeedEntry[];
  /** Stopped at a trace that is not settled or not fully written yet; later traces wait behind it. */
  blocked: boolean;
  /** More entries followed this page when it was read. */
  hasMore: boolean;
}

/**
 * Reads the next settled trace versions after `cursor` from the durable trace
 * feed: one row per trace in evaluator_trace_feed, moved to the end whenever
 * the ingest worker commits new trace or observation activity for it, after
 * the ClickHouse rows are written. Reading that feed rather than scanning
 * ClickHouse by activity time means a batch written late (queue backlog,
 * recovery after Redis loss) is still sent: its feed position is assigned
 * when it commits, not when the API received it.
 *
 * The rules follow the live phase of GET /api/v1/evaluator/traces
 * (apps/api/src/routes/evaluator.ts), so nothing is skipped: stop at the
 * first trace still inside its quiet period or still being written, stop when
 * ClickHouse already holds a newer snapshot than the feed row, and step over
 * traces retention removed.
 */
export async function readSettledTraceFeed(
  deps: { pool: Pool; clickhouse: ClickHouseClient },
  input: {
    projectId: string;
    cursor: DestinationFeedCursor | null;
    settledBefore: string;
    limit: number;
  }
): Promise<SettledFeedPage> {
  const { pool, clickhouse } = deps;
  const { projectId } = input;
  const activities = await listEvaluatorTraceActivities(pool, {
    projectId,
    ...(input.cursor && { cursor: input.cursor }),
    limit: input.limit + 1
  });
  const window = activities.slice(0, input.limit);
  const traceIds = window.map((activity) => activity.traceId);
  const [currentByTraceId, pendingTraceIds] = await Promise.all([
    getVersionedTraceSummaries(clickhouse, projectId, traceIds),
    pendingTraces(deps, projectId, traceIds)
  ]);

  const entries: SettledFeedEntry[] = [];
  const blockedPage = { entries, blocked: true, hasMore: false };
  for (const activity of window) {
    if (activity.sourceActivityAt > input.settledBefore || pendingTraceIds.has(activity.traceId)) {
      return blockedPage;
    }
    let trace = currentByTraceId.get(activity.traceId);
    if (!trace || trace.trace_version < activity.sourceActivityAt) {
      // A pull import marks a trace pending before it tombstones the old rows,
      // and the reads above can observe those in the opposite order. Re-check
      // pending around a fresh read before treating the trace as removed.
      if ((await pendingTraces(deps, projectId, [activity.traceId])).size > 0) return blockedPage;
      trace = (await getVersionedTraceSummaries(clickhouse, projectId, [activity.traceId])).get(
        activity.traceId
      );
      if ((await pendingTraces(deps, projectId, [activity.traceId])).size > 0) return blockedPage;
    }
    const cursor = { publishedAt: activity.publishedAt, traceId: activity.traceId };
    if (!trace || trace.trace_version < activity.sourceActivityAt) {
      entries.push({ cursor });
      continue;
    }
    if (trace.trace_version > activity.sourceActivityAt) {
      // The worker is about to publish this newer snapshot; wait for it.
      return blockedPage;
    }
    entries.push({ cursor, trace, version: activity.traceVersion });
  }
  return { entries, blocked: false, hasMore: activities.length > input.limit };
}

async function pendingTraces(
  deps: { pool: Pool; clickhouse: ClickHouseClient },
  projectId: string,
  traceIds: string[]
): Promise<Set<string>> {
  const [raw, imports] = await Promise.all([
    listPendingTraceRawRefIds(deps.clickhouse, projectId, traceIds),
    listPendingEvaluatorImportTraceIds(deps.pool, projectId, traceIds)
  ]);
  return new Set([...raw, ...imports]);
}
