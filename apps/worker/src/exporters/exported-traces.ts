import {
  getVersionedTraces,
  listObservationsForTraces,
  listScoresForTraces,
  type ClickHouseClient
} from "@ironside/clickhouse";
import type { Observation, Score, Trace } from "@ironside/shared";
import { observationFromStoredRow, scoreFromStoredRow, traceFromStoredRow } from "../lib/stored-rows.js";

/** One trace as a destination receives it: the full tree at one settled version. */
export interface ExportedTrace {
  trace: Trace;
  observations: Observation[];
  scores: Score[];
  /** Server-owned snapshot version: the trace's latest trace/observation activity. */
  traceVersion: string;
}

/**
 * Loads complete traces for one feed page in three queries. Traces removed
 * since the page was read are absent from the result.
 */
export async function loadExportedTraces(
  clickhouse: ClickHouseClient,
  projectId: string,
  traceIds: string[]
): Promise<Map<string, ExportedTrace>> {
  if (traceIds.length === 0) return new Map();
  const [traces, observations, scores] = await Promise.all([
    getVersionedTraces(clickhouse, projectId, traceIds),
    listObservationsForTraces(clickhouse, projectId, traceIds),
    listScoresForTraces(clickhouse, projectId, traceIds)
  ]);
  const loaded = new Map<string, ExportedTrace>();
  for (const [traceId, row] of traces) {
    loaded.set(traceId, {
      trace: traceFromStoredRow(projectId, row),
      observations: [],
      scores: [],
      traceVersion: row.trace_version
    });
  }
  for (const row of observations) {
    loaded.get(row.trace_id)?.observations.push(observationFromStoredRow(projectId, row));
  }
  for (const row of scores) {
    loaded.get(row.trace_id)?.scores.push(scoreFromStoredRow(projectId, row));
  }
  return loaded;
}
