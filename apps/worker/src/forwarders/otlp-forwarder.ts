import { listObservationsForTraces, type ClickHouseClient, type ObservationRow } from "@ironside/clickhouse";
import { recordOtlpForwardRun, type OtlpForwardRule } from "@ironside/db";
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
/** One unresponsive destination must not hold the scheduler tick, which runs every subsystem in turn. */
const REQUEST_TIMEOUT_MS = 30_000;

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
  /** Per-request timeout; tests shorten it. Default 30 s. */
  requestTimeoutMs?: number;
}

export interface ForwardOtlpResult {
  matched: number;
  forwarded: number;
  /**
   * Traces the destination did not accept. A rejection of the trace itself
   * (400, 413, 422) is `skipped`: the run steps over that trace and continues.
   * Any other failure stops the run before the trace, which is retried next run.
   */
  failed: { traceId: string; error: string; skipped: boolean }[];
}

/**
 * Statuses that reject this trace's content, so a retry fails the same way.
 * Other 4xx statuses (401, 403, 404, 405, ...) describe the destination or
 * its configuration: skipping on those would drop every trace until the rule
 * is fixed, so they stop the run like a 5xx.
 */
const TRACE_REJECTION_STATUSES = new Set([400, 413, 422]);

function isPermanentRejection(status: number): boolean {
  return TRACE_REJECTION_STATUSES.has(status);
}

/**
 * Forwards settled trace versions published after the rule's feed position
 * to its destination, one OTLP/HTTP+JSON export request per trace, in feed
 * order (spec/otlp-forwarding-v1.md). The position advances past each trace
 * the destination accepts. A timeout, network error, or any status other than
 * a rejection of the trace itself stops the run with the position before that
 * trace, so an unreachable or misconfigured destination delays delivery
 * instead of skipping traces. A rejection of the trace (400, 413, 422) skips
 * that one trace so it cannot block the rule for good. Every
 * run records its status on the rule. Delivery is at-least-once, and because
 * OTLP ids are derived deterministically a resent trace is the same trace
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
  let backlog = false;
  let runError: unknown;
  const result: ForwardOtlpResult = { matched: 0, forwarded: 0, failed: [] };
  try {
    let examined = 0;
    read: for (;;) {
      const page = await readSettledTraceFeed(
        { pool, clickhouse },
        {
          projectId: rule.projectId,
          cursor,
          settledBefore,
          limit: Math.min(FEED_PAGE_SIZE, MAX_TRACES_PER_RUN - result.forwarded)
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
          result.matched += 1;
          const trace = entry.trace;
          const outcome = await sendTrace(fetchImpl, rule, options, {
            id: trace.id,
            timestamp: trace.timestamp,
            name: trace.name,
            observations: buildObservationTree(observationsByTrace.get(trace.id) ?? [])
          });
          if (outcome.error !== undefined) {
            result.failed.push({ traceId: trace.id, error: outcome.error, skipped: outcome.permanent });
            if (!outcome.permanent) break read;
          } else {
            result.forwarded += 1;
          }
        }
        cursor = entry.cursor;
      }
      examined += page.entries.length;

      if (page.blocked || !page.hasMore) break;
      if (result.forwarded >= MAX_TRACES_PER_RUN || examined >= MAX_FEED_ENTRIES_PER_RUN) {
        backlog = true;
        break;
      }
    }
    return result;
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    // Also on failure: keep the progress made before it.
    const errors = [
      ...result.failed.map((failure) =>
        `${failure.traceId}${failure.skipped ? " (skipped)" : ""}: ${failure.error}`
      ),
      ...(runError === undefined ? [] : [runError instanceof Error ? runError.message : String(runError)])
    ];
    await recordOtlpForwardRun(pool, rule.id, {
      status: errors.length > 0 ? "error" : "success",
      ...(errors.length > 0 && { error: errors.join("; ").slice(0, 2_000) }),
      forwarded: result.forwarded,
      feedCursor: { from: rule.feedCursor, to: cursor },
      runAgainSoon: backlog
    });
  }
}

async function sendTrace(
  fetchImpl: typeof fetch,
  rule: OtlpForwardRule,
  options: Pick<ForwardOtlpOptions, "destinationAuthHeader" | "requestTimeoutMs">,
  trace: Parameters<typeof mapTraceToOtlpExportRequest>[0]
): Promise<{ error?: undefined } | { error: string; permanent: boolean }> {
  try {
    const response = await fetchImpl(rule.destinationUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.destinationAuthHeader && { authorization: options.destinationAuthHeader })
      },
      body: JSON.stringify(mapTraceToOtlpExportRequest(trace)),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
    });
    await response.body?.cancel().catch(() => {});
    if (response.ok) return {};
    return {
      error: `destination responded HTTP ${response.status}`,
      permanent: isPermanentRejection(response.status)
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), permanent: false };
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
