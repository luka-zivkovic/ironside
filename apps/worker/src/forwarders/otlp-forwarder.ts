import { exportTraces, getTrace, listObservationsForTrace, type ClickHouseClient } from "@ironside/clickhouse";
import { buildObservationTree } from "@ironside/mappers";
import type { OtlpForwardRule } from "@ironside/db";
import { traceSettledBefore } from "@ironside/shared";
import { assertPublicHttpDestination } from "../lib/ssrf-guard.js";
import { mapTraceToOtlpExportRequest } from "./otlp-mapper.js";

export interface ForwardOtlpOptions {
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
  failed: { traceId: string; error: string }[];
}

/**
 * Forwards every currently-matching trace (per the rule's filter) to the
 * rule's destination as one OTLP/HTTP+JSON export request per trace. Each
 * trace is forwarded independently — one trace's failure (destination
 * timeout, malformed response) doesn't block the rest, matching the
 * ingest-side "one bad event doesn't fail the whole batch" policy used
 * throughout the codebase.
 *
 * `rule.destinationUrl` is customer-supplied, so before sending anything
 * this validates it resolves to a public address — the same SSRF guard
 * runWebhooks already applies, closing the gap flagged in
 * spec/otlp-forwarding-v1.md (previously the only pre-API-route,
 * callable-only building block among the M6 trio without it).
 */
export async function forwardOtlpTraces(options: ForwardOtlpOptions): Promise<ForwardOtlpResult> {
  const { clickhouse, rule } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const settledBefore = traceSettledBefore(options.traceQuietPeriodSeconds);

  if (!options.allowPrivateDestinations) {
    await assertPublicHttpDestination(rule.destinationUrl);
  }

  const summaries = await exportTraces(clickhouse, {
    projectId: rule.projectId,
    ...rule.filter,
    settledBefore
  });

  let forwarded = 0;
  const failed: { traceId: string; error: string }[] = [];

  for (const summary of summaries) {
    try {
      const [trace, observationRows] = await Promise.all([
        getTrace(clickhouse, rule.projectId, summary.id, settledBefore),
        listObservationsForTrace(clickhouse, rule.projectId, summary.id)
      ]);
      if (!trace) continue; // deleted between the list query and here — skip, not an error

      const observations = buildObservationTree(observationRows);
      const otlpRequest = mapTraceToOtlpExportRequest({
        id: trace.id,
        timestamp: trace.timestamp,
        name: trace.name,
        observations
      });

      const response = await fetchImpl(rule.destinationUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.destinationAuthHeader && { authorization: options.destinationAuthHeader })
        },
        body: JSON.stringify(otlpRequest)
      });
      if (!response.ok) {
        throw new Error(`destination responded HTTP ${response.status}`);
      }
      forwarded += 1;
    } catch (error) {
      failed.push({
        traceId: summary.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { matched: summaries.length, forwarded, failed };
}
