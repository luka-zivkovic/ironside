import { listObservationsForTraces, type ClickHouseClient, type ObservationRow } from "@ironside/clickhouse";
import { recordOtlpForwardProgress, type OtlpForwardRule } from "@ironside/db";
import { buildObservationTree } from "@ironside/mappers";
import { traceSettledBefore } from "@ironside/shared";
import type { Pool } from "pg";
import { readSettledTraceFeed } from "../exporters/settled-trace-feed.js";
import { matchesExportFilter } from "../exporters/trace-filter.js";
import { assertPublicHttpDestination } from "../lib/ssrf-guard.js";
import { mapTraceToOtlpExportRequest } from "./otlp-mapper.js";

const FEED_PAGE_SIZE = 100;
/** Traces per run; a larger backlog continues on the next scheduler tick. */
const MAX_TRACES_PER_RUN = 5_000;
/** Feed entries examined per run, which bounds a run whose filter matches few traces. */
const MAX_FEED_ENTRIES_PER_RUN = 100_000;

export interface ForwardOtlpOptions {
  pool: Pool;
  clickhouse: ClickHouseClient;
  rule: OtlpForwardRule;
  /** Decrypted auth header value — decrypting is the API layer's job (has the encryption secret); the worker only ever handles a rule with this already resolved. Same contract as export-runner.ts's destinationSecretAccessKey. */
  destinationAuthHeader?: string;
  fetchImpl?: typeof fetch;
  /** Test-only escape hatch, same contract as runWebhooks' identical option. */
  allowPrivateDestinations?: boolean;
  /** Project-effective quiet period used to exclude in-flight traces. */
  traceQuietPeriodSeconds: number;
}

export interface ForwardOtlpResult {
  matched: number;
  forwarded: number;
  /** The trace the destination rejected, which stopped the run; empty when every matched trace was accepted. */
  failed: { traceId: string; error: string }[];
}

/**
 * Forwards settled trace versions published after the rule's feed position
 * to its destination, one OTLP/HTTP+JSON export request per trace, in feed
 * order (spec/otlp-forwarding-v1.md). The position advances past each trace
 * the destination accepts. The first rejected request stops the run with the
 * position still before that trace, so an unreachable destination delays
 * delivery instead of skipping traces. Delivery is at-least-once: OTLP ids
 * are derived deterministically, so a resent trace is the same trace
 * downstream.
 *
 * `rule.destinationUrl` is customer-supplied, so before sending anything
 * this validates it resolves to a public address — the same SSRF guard
 * runWebhooks already applies.
 */
export async function forwardOtlpTraces(options: ForwardOtlpOptions): Promise<ForwardOtlpResult> {
  const { pool, clickhouse, rule } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const settledBefore = traceSettledBefore(options.traceQuietPeriodSeconds);

  if (!options.allowPrivateDestinations) {
    await assertPublicHttpDestination(rule.destinationUrl);
  }

  let cursor = rule.feedCursor;
  let matched = 0;
  let forwarded = 0;
  let examined = 0;
  let backlog = false;
  const failed: ForwardOtlpResult["failed"] = [];
  try {
    for (;;) {
      const page = await readSettledTraceFeed(
        { pool, clickhouse },
        {
          projectId: rule.projectId,
          cursor,
          settledBefore,
          limit: Math.min(FEED_PAGE_SIZE, MAX_TRACES_PER_RUN - forwarded)
        }
      );
      const wanted = page.entries.flatMap((entry) =>
        entry.trace && matchesExportFilter(entry.trace, rule.filter) ? [entry.trace] : []
      );
      const observationsByTrace = groupByTrace(
        await listObservationsForTraces(clickhouse, rule.projectId, wanted.map((trace) => trace.id))
      );

      for (const entry of page.entries) {
        if (entry.trace && matchesExportFilter(entry.trace, rule.filter)) {
          matched += 1;
          const trace = entry.trace;
          try {
            const response = await fetchImpl(rule.destinationUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(options.destinationAuthHeader && { authorization: options.destinationAuthHeader })
              },
              body: JSON.stringify(
                mapTraceToOtlpExportRequest({
                  id: trace.id,
                  timestamp: trace.timestamp,
                  name: trace.name,
                  observations: buildObservationTree(observationsByTrace.get(trace.id) ?? [])
                })
              )
            });
            await response.body?.cancel().catch(() => {});
            if (!response.ok) {
              throw new Error(`destination responded HTTP ${response.status}`);
            }
          } catch (error) {
            failed.push({
              traceId: trace.id,
              error: error instanceof Error ? error.message : String(error)
            });
            return { matched, forwarded, failed };
          }
          forwarded += 1;
        }
        cursor = entry.cursor;
      }
      examined += page.entries.length;

      if (page.blocked || !page.hasMore) break;
      if (forwarded >= MAX_TRACES_PER_RUN || examined >= MAX_FEED_ENTRIES_PER_RUN) {
        backlog = true;
        break;
      }
    }
    return { matched, forwarded, failed };
  } finally {
    // Also on a rejected trace: keep the progress made before it.
    const moved =
      cursor?.publishedAt !== rule.feedCursor?.publishedAt || cursor?.traceId !== rule.feedCursor?.traceId;
    if (moved || backlog) {
      await recordOtlpForwardProgress(pool, rule.id, { feedCursor: cursor, runAgainSoon: backlog });
    }
  }
}

function groupByTrace(rows: ObservationRow[]): Map<string, ObservationRow[]> {
  const byTrace = new Map<string, ObservationRow[]>();
  for (const row of rows) {
    const group = byTrace.get(row.trace_id);
    if (group) group.push(row);
    else byTrace.set(row.trace_id, [row]);
  }
  return byTrace;
}
