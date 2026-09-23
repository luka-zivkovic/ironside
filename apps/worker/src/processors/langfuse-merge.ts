import { listObservationsByIds, listTracesByIds, type ClickHouseClient } from "@ironside/clickhouse";
import type { MappedLangfuseRows } from "@ironside/mappers";
import {
  COST_MODEL_METADATA_KEY,
  COST_SOURCE_METADATA_KEY,
  COST_TABLE_METADATA_KEY
} from "@ironside/pricing";
import type { Observation, Trace } from "@ironside/shared";
import { observationFromStoredRow, traceFromStoredRow } from "../lib/stored-rows.js";

const COST_METADATA_KEYS = [COST_SOURCE_METADATA_KEY, COST_MODEL_METADATA_KEY, COST_TABLE_METADATA_KEY];

/**
 * LangFuse SDKs send each record as a create followed by partial updates and
 * flush on a timer, so an update routinely arrives in a later request than
 * its create. Rows are whole-row upserts, so writing the update as mapped
 * would erase the fields only the create carried (name, model, input) and
 * move the start time to the update's timestamp. This fills every field the
 * incoming events did not send from the stored row before the write.
 *
 * It covers the normal order, where the earlier request was materialized
 * first. Two requests for one record processed at the same time can still
 * each miss the other's fields (spec/langfuse-compat-v1.md).
 */
export async function fillLangfuseRowsFromStored(
  clickhouse: ClickHouseClient,
  projectId: string,
  rows: MappedLangfuseRows
): Promise<{ traces: Trace[]; observations: Observation[] }> {
  const [storedTraces, storedObservations] = await Promise.all([
    listTracesByIds(
      clickhouse,
      projectId,
      rows.traces.map((trace) => trace.id)
    ),
    listObservationsByIds(
      clickhouse,
      projectId,
      rows.observations.map((observation) => ({ id: observation.id, traceId: observation.traceId }))
    )
  ]);
  const tracesById = new Map(storedTraces.map((row) => [row.id, row]));
  const observationsById = new Map(storedObservations.map((row) => [row.id, row]));

  const traces = rows.traces.map((trace) => {
    const stored = tracesById.get(trace.id);
    const provided = rows.providedFields.traces.get(trace.id);
    if (!stored || !provided) return trace;
    return fillUnprovidedTraceFields(trace, provided, traceFromStoredRow(projectId, stored));
  });
  const observations = rows.observations.map((observation) => {
    const stored = observationsById.get(observation.id);
    const provided = rows.providedFields.observations.get(observation.id);
    if (!stored || !provided || stored.trace_id !== observation.traceId) return observation;
    return fillUnprovidedObservationFields(
      observation,
      provided,
      observationFromStoredRow(projectId, stored)
    );
  });
  return { traces, observations };
}

export function fillUnprovidedTraceFields(
  incoming: Trace,
  provided: ReadonlySet<keyof Trace>,
  stored: Trace
): Trace {
  return fillUnprovided(incoming, provided, stored);
}

export function fillUnprovidedObservationFields(
  incoming: Observation,
  provided: ReadonlySet<keyof Observation>,
  stored: Observation
): Observation {
  const merged = fillUnprovided(incoming, provided, stored);
  const storedCostWasDerived =
    stored.costDetails !== undefined && stored.metadata[COST_SOURCE_METADATA_KEY] !== undefined;
  if (provided.has("costDetails") || !storedCostWasDerived) return merged;

  if (provided.has("usageDetails") || provided.has("model")) {
    // The stored cost was derived from the old usage/model; drop it so cost
    // enrichment derives it again from the merged values.
    delete merged.costDetails;
    merged.metadata = Object.fromEntries(
      Object.entries(merged.metadata).filter(([key]) => !COST_METADATA_KEYS.includes(key))
    );
  } else if (provided.has("metadata")) {
    // New metadata replaced the stored map; keep the carried cost's provenance.
    for (const key of COST_METADATA_KEYS) {
      const value = stored.metadata[key];
      if (value !== undefined) merged.metadata = { ...merged.metadata, [key]: value };
    }
  }
  return merged;
}

function fillUnprovided<Row extends object>(
  incoming: Row,
  provided: ReadonlySet<keyof Row>,
  stored: Row
): Row {
  const merged = { ...incoming };
  for (const key of Object.keys(stored) as (keyof Row)[]) {
    if (!provided.has(key) && stored[key] !== undefined) merged[key] = stored[key];
  }
  return merged;
}
