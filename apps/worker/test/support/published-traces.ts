import {
  insertObservations,
  insertScores,
  insertTraces,
  type ClickHouseClient
} from "@ironside/clickhouse";
import { publishEvaluatorTraceActivities } from "@ironside/db";
import type { Observation, Score, Trace } from "@ironside/shared";
import type { Pool } from "pg";
import { ulid } from "ulid";

/**
 * Writes a trace the way the ingest worker materializes a batch: rows carry
 * the batch's receive time as their version, then the trace is published to
 * the durable feed that scheduled destinations read.
 */
export async function insertPublishedTrace(
  deps: { pool: Pool; clickhouse: ClickHouseClient },
  input: { trace: Trace; observations?: Observation[]; scores?: Score[]; receivedAt?: string }
): Promise<string> {
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const options = { eventTs: receivedAt };
  await insertTraces(deps.clickhouse, [input.trace], options);
  await insertObservations(deps.clickhouse, input.observations ?? [], options);
  await insertScores(deps.clickhouse, input.scores ?? [], options);
  await publishEvaluatorTraceActivities(deps.pool, {
    projectId: input.trace.projectId,
    traceIds: [input.trace.id],
    sourceActivityAt: receivedAt,
    activityId: `batch_${ulid()}`
  });
  return receivedAt;
}
