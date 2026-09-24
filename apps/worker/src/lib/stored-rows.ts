import type { ObservationRow, ScoreRow, TraceDetailRow } from "@ironside/clickhouse";
import { safeJsonParse } from "@ironside/mappers";
import type {
  Observation,
  ObservationLevel,
  ObservationType,
  Score,
  ScoreDataType,
  ScoreSource,
  Trace
} from "@ironside/shared";

// Stored ClickHouse rows back to domain objects: the shape the worker writes
// and native ingest accepts (minus projectId). Nullable columns read back as
// absent fields, and input/output are parsed from the JSON text they are
// stored as.

export function traceFromStoredRow(projectId: string, row: TraceDetailRow): Trace {
  return {
    id: row.id,
    projectId,
    timestamp: row.timestamp,
    tags: row.tags,
    metadata: row.metadata,
    ...(row.name !== null && { name: row.name }),
    ...(row.user_id !== null && { userId: row.user_id }),
    ...(row.session_id !== null && { sessionId: row.session_id }),
    ...(row.environment !== null && { environment: row.environment }),
    ...(row.release !== null && { release: row.release }),
    ...(row.version !== null && { version: row.version }),
    ...(row.input !== null && { input: safeJsonParse(row.input) }),
    ...(row.output !== null && { output: safeJsonParse(row.output) })
  };
}

/** Empty maps are how absent usage/cost/parameters are stored, so they read back as absent. */
export function observationFromStoredRow(projectId: string, row: ObservationRow): Observation {
  return {
    id: row.id,
    traceId: row.trace_id,
    projectId,
    type: row.type as ObservationType,
    startTime: row.start_time,
    level: row.level as ObservationLevel,
    metadata: row.metadata,
    ...(row.parent_observation_id !== null && { parentObservationId: row.parent_observation_id }),
    ...(row.name !== null && { name: row.name }),
    ...(row.end_time !== null && { endTime: row.end_time }),
    ...(row.status_message !== null && { statusMessage: row.status_message }),
    ...(row.model !== null && { model: row.model }),
    ...(Object.keys(row.model_parameters).length > 0 && { modelParameters: row.model_parameters }),
    ...(row.input !== null && { input: safeJsonParse(row.input) }),
    ...(row.output !== null && { output: safeJsonParse(row.output) }),
    ...(Object.keys(row.usage_details).length > 0 && { usageDetails: row.usage_details }),
    ...(Object.keys(row.cost_details).length > 0 && { costDetails: row.cost_details }),
    ...(row.completion_start_time !== null && { completionStartTime: row.completion_start_time })
  };
}

export function scoreFromStoredRow(projectId: string, row: ScoreRow): Score {
  return {
    id: row.id,
    projectId,
    traceId: row.trace_id,
    name: row.name,
    dataType: row.data_type as ScoreDataType,
    source: row.source as ScoreSource,
    timestamp: row.timestamp,
    metadata: row.metadata,
    ...(row.observation_id !== null && { observationId: row.observation_id }),
    ...(row.value !== null && { value: row.value }),
    ...(row.string_value !== null && { stringValue: row.string_value }),
    ...(row.comment !== null && { comment: row.comment })
  };
}
