import { createHmac } from "node:crypto";
import type { ClickHouseClient, VersionedTraceSummaryRow } from "@ironside/clickhouse";
import {
  claimWebhookDelivery,
  coverScannerDelivery,
  getWebhookDeliveryStatus,
  listScannerDeliveries,
  markWebhookDelivered,
  markWebhookFailed,
  recordWebhookRun,
  type WebhookRule
} from "@ironside/db";
import { traceSettledBefore } from "@ironside/shared";
import type { Pool } from "pg";
import { ulid } from "ulid";
import { readSettledTraceFeed, type SettledFeedEntry } from "../exporters/settled-trace-feed.js";
import { matchesExportFilter } from "../exporters/trace-filter.js";
import { assertPublicHttpDestination } from "../lib/ssrf-guard.js";

const FEED_PAGE_SIZE = 100;
/** Deliveries per run; a larger backlog continues on the next scheduler tick. */
const MAX_DELIVERIES_PER_RUN = 1_000;
/** Feed entries examined per run, which bounds a run whose filter matches few traces. */
const MAX_FEED_ENTRIES_PER_RUN = 100_000;
/** One unresponsive destination must not hold the scheduler tick, which runs every subsystem in turn. */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * How long after a rule's scanner handoff a worker from the previous release
 * may still be delivering it during a rolling upgrade.
 */
export const SCANNER_HANDOFF_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RunWebhooksOptions {
  pool: Pool;
  clickhouse: ClickHouseClient;
  rule: WebhookRule;
  /** Decrypted HMAC signing secret — decrypting is the API layer's job, same contract as export-runner.ts/otlp-forwarder.ts. */
  signingSecret: string;
  fetchImpl?: typeof fetch;
  /**
   * Skips the SSRF guard on `rule.destinationUrl`. Only ever set by tests
   * against a local mock server (which legitimately resolves to
   * loopback) — never by production code paths, which must always be
   * guarded against a customer-supplied destination reaching internal
   * network addresses.
   */
  allowPrivateDestinations?: boolean;
  /** Project-effective quiet period used to exclude in-flight traces. */
  traceQuietPeriodSeconds: number;
  /** Per-request timeout; tests shorten it. Default 30 s. */
  requestTimeoutMs?: number;
}

export interface WebhookRunResult {
  matched: number;
  delivered: number;
  /** This settled version was already delivered — correctly skipped, not an error. */
  skipped: number;
  /** The delivery the run stopped at. It is retried from the same feed position on the next run. */
  failed: { traceId: string; error: string }[];
  /** Set when the run stopped at a trace another run is still delivering. */
  waitingFor?: string;
}

interface WebhookPayload {
  event: "trace.matched";
  traceId: string;
  projectId: string;
  timestamp: string;
  name: string | null;
  /** The trace's feed version: the same token the evaluator API and exports use. */
  traceVersion: string;
}

type DeliveryOutcome = "delivered" | "already-delivered" | "in-flight" | { error: string };

/**
 * Delivers a webhook POST for each matching settled trace version published
 * to the durable trace feed after the rule's position, in feed order
 * (spec/webhooks-v1.md). Each version is delivered successfully exactly once:
 * claimWebhookDelivery's atomic INSERT ... ON CONFLICT claims the
 * (rule, trace, version) tuple before the request, so a concurrent or retried
 * run can never send it again once it succeeded. The position advances past
 * each delivered or already-delivered version. A failed request stops the run
 * before that trace, so an unreachable or misconfigured destination delays
 * delivery instead of skipping traces; so does a version another run is
 * still sending. Every run records its status on the rule.
 *
 * Workers before migration 0006 keyed a delivery by the trace's activity
 * time instead of its feed version. A run honors those deliveries for feed
 * entries published before the rule's scanner handoff, and for a day after
 * it, when such a worker may still be running beside this one; in that window
 * it also marks each trace it delivers under the old key, so the older worker
 * does not send it again.
 *
 * Body is signed with HMAC-SHA256 over the raw JSON string (not a
 * re-serialized object, which could differ byte-for-byte from what was
 * signed) in an X-Ironside-Signature header, so the receiver can verify
 * authenticity — same pattern as Stripe/GitHub webhook signing.
 *
 * `rule.destinationUrl` is customer-supplied (set via the rule-creation
 * API), so before sending anything this validates it resolves to a public
 * address — otherwise the worker is an SSRF proxy into whatever network
 * it runs on (cloud metadata endpoints, internal services). Checked once
 * per run, not per-trace: the destination is fixed for the whole rule.
 */
export async function runWebhooks(options: RunWebhooksOptions): Promise<WebhookRunResult> {
  const { pool, clickhouse, rule } = options;
  const settledBefore = traceSettledBefore(options.traceQuietPeriodSeconds);
  const handoffOpen = Date.now() < Date.parse(rule.scannerHandoffAt) + SCANNER_HANDOFF_WINDOW_MS;

  let cursor = rule.feedCursor;
  let backlog = false;
  let runError: unknown;
  const result: WebhookRunResult = { matched: 0, delivered: 0, skipped: 0, failed: [] };
  try {
    if (!options.allowPrivateDestinations) {
      await assertPublicHttpDestination(rule.destinationUrl);
    }

    let examined = 0;
    read: for (;;) {
      const page = await readSettledTraceFeed(
        { pool, clickhouse },
        {
          projectId: rule.projectId,
          cursor,
          settledBefore,
          limit: Math.min(FEED_PAGE_SIZE, MAX_DELIVERIES_PER_RUN - result.delivered)
        }
      );
      const scannerDeliveries = await listScannerDeliveriesOnPage(pool, rule, page.entries, handoffOpen);

      for (const entry of page.entries) {
        const { trace, version } = entry;
        if (trace && version !== undefined && matchesExportFilter(trace, rule.filter)) {
          result.matched += 1;
          const scanner = scannerDeliveries.get(trace.id);
          const outcome =
            scanner === "delivered"
              ? "already-delivered"
              : scanner === "in-flight"
                ? "in-flight"
                : await deliver(options, trace, version);
          if (outcome === "delivered") {
            result.delivered += 1;
            if (handoffOpen) {
              await coverScannerDelivery(pool, ulid(), rule.id, trace.id, trace.trace_version);
            }
          } else if (outcome === "already-delivered") {
            result.skipped += 1;
          } else if (outcome === "in-flight") {
            result.waitingFor = trace.id;
            break read;
          } else {
            result.failed.push({ traceId: trace.id, error: outcome.error });
            break read;
          }
        }
        cursor = entry.cursor;
      }
      examined += page.entries.length;

      if (page.blocked || !page.hasMore) break;
      if (result.delivered >= MAX_DELIVERIES_PER_RUN || examined >= MAX_FEED_ENTRIES_PER_RUN) {
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
      ...result.failed.map((failure) => `${failure.traceId}: ${failure.error}`),
      ...(runError === undefined ? [] : [runError instanceof Error ? runError.message : String(runError)])
    ];
    // Waiting behind an in-flight delivery is not a failure, but it explains a run that stopped.
    const note =
      errors.length > 0
        ? errors.join("; ")
        : result.waitingFor !== undefined
          ? `stopped at ${result.waitingFor}: another run is still delivering it`
          : undefined;
    await recordWebhookRun(pool, rule.id, {
      status: errors.length > 0 ? "error" : "success",
      ...(note !== undefined && { error: note.slice(0, 2_000) }),
      delivered: result.delivered,
      feedCursor: { from: rule.feedCursor, to: cursor },
      runAgainSoon: backlog
    });
  }
}

/**
 * What a pre-0006 worker delivered, or is delivering, for this page's traces
 * under their activity time, which a feed entry carries as
 * `trace.trace_version`. Only entries published before the rule's handoff can
 * have such a delivery, unless a previous-release worker may still be running.
 */
async function listScannerDeliveriesOnPage(
  pool: Pool,
  rule: WebhookRule,
  entries: SettledFeedEntry[],
  handoffOpen: boolean
): Promise<Map<string, "delivered" | "in-flight">> {
  const versions = entries.flatMap((entry) =>
    entry.trace && (handoffOpen || entry.cursor.publishedAt <= rule.scannerHandoffAt)
      ? [{ traceId: entry.trace.id, activityVersion: entry.trace.trace_version }]
      : []
  );
  return listScannerDeliveries(pool, rule.id, versions);
}

async function deliver(
  options: RunWebhooksOptions,
  trace: VersionedTraceSummaryRow,
  version: string
): Promise<DeliveryOutcome> {
  const { pool, rule } = options;
  const deliveryId = await claimWebhookDelivery(pool, ulid(), rule.id, trace.id, version);
  if (!deliveryId) {
    const status = await getWebhookDeliveryStatus(pool, rule.id, trace.id, version);
    return status === "delivered" || status === "covered" ? "already-delivered" : "in-flight";
  }

  const body = JSON.stringify({
    event: "trace.matched",
    traceId: trace.id,
    projectId: rule.projectId,
    timestamp: trace.timestamp,
    name: trace.name,
    traceVersion: version
  } satisfies WebhookPayload);
  const signature = createHmac("sha256", options.signingSecret).update(body).digest("hex");

  try {
    const response = await (options.fetchImpl ?? fetch)(rule.destinationUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ironside-signature": `sha256=${signature}`
      },
      body,
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) {
      throw new Error(`destination responded HTTP ${response.status}`);
    }
  } catch (error) {
    // Only a failed/unconfirmed HTTP attempt is retryable — the
    // destination has not (confirmably) received this webhook yet.
    const message = error instanceof Error ? error.message : String(error);
    await markWebhookFailed(pool, deliveryId, message);
    return { error: message };
  }

  // The HTTP delivery itself succeeded — the destination has already
  // received and processed this webhook, a real non-idempotent side
  // effect. A failure here is a bookkeeping problem, not a delivery
  // problem: it must NOT be treated as retryable (markWebhookFailed
  // would let a future run send a genuine duplicate). Let it propagate
  // so the caller/ops sees "delivered but failed to record" distinctly.
  await markWebhookDelivered(pool, deliveryId);
  return "delivered";
}
