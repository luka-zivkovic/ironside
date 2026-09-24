import { createHmac } from "node:crypto";
import type { ClickHouseClient, VersionedTraceSummaryRow } from "@ironside/clickhouse";
import {
  claimWebhookDelivery,
  getWebhookDeliveryStatus,
  markWebhookCovered,
  markWebhookDelivered,
  markWebhookFailed,
  recordWebhookRun,
  type WebhookRule
} from "@ironside/db";
import { traceSettledBefore } from "@ironside/shared";
import type { Pool } from "pg";
import { ulid } from "ulid";
import { readSettledTraceFeed } from "../exporters/settled-trace-feed.js";
import { matchesExportFilter } from "../exporters/trace-filter.js";
import { assertPublicHttpDestination, publicFetch } from "../lib/ssrf-guard.js";

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
 * How a run treats a trace's scanner key, the activity-time key a pre-0006
 * worker delivers under: claim it like that worker does while one may still
 * be running, only look for its delivery once none can be, or ignore it.
 */
type ScannerKeyMode = "claim" | "check" | "none";

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
 * time (its scanner key) instead of its feed version. For a day after the
 * rule's scanner handoff, when such a worker may still be running beside this
 * one, a run claims the scanner key before sending, exactly as that worker
 * does, and marks it covered after sending, so each trace is sent by only one
 * of them. After that day it only skips traces that worker delivered, for
 * entries published before the day ended.
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
  const handoffEnds = Date.parse(rule.scannerHandoffAt) + SCANNER_HANDOFF_WINDOW_MS;
  const scannerKeyMode = (entry: { cursor: { publishedAt: string } }): ScannerKeyMode =>
    Date.now() < handoffEnds ? "claim" : Date.parse(entry.cursor.publishedAt) <= handoffEnds ? "check" : "none";

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

      for (const entry of page.entries) {
        const { trace, version } = entry;
        if (trace && version !== undefined && matchesExportFilter(trace, rule.filter)) {
          result.matched += 1;
          const outcome = await deliver(options, trace, version, scannerKeyMode(entry));
          if (outcome === "delivered") {
            result.delivered += 1;
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

async function deliver(
  options: RunWebhooksOptions,
  trace: VersionedTraceSummaryRow,
  version: string,
  scannerKeyMode: ScannerKeyMode
): Promise<DeliveryOutcome> {
  const { pool, rule } = options;
  // The scanner key is the trace's activity time, which a feed entry carries as trace_version.
  const scannerKey = trace.trace_version;
  let scannerClaimId: string | null = null;
  if (scannerKeyMode === "claim") {
    scannerClaimId = await claimWebhookDelivery(pool, ulid(), rule.id, trace.id, scannerKey);
    if (!scannerClaimId) {
      const status = await getWebhookDeliveryStatus(pool, rule.id, trace.id, scannerKey);
      if (status === "delivered") return "already-delivered";
      // "covered": an earlier feed version of this trace, with the same
      // activity time, already holds the key; this version is still new.
      if (status !== "covered") return "in-flight";
    }
  } else if (scannerKeyMode === "check") {
    if ((await getWebhookDeliveryStatus(pool, rule.id, trace.id, scannerKey)) === "delivered") {
      return "already-delivered";
    }
  }

  const deliveryId = await claimWebhookDelivery(pool, ulid(), rule.id, trace.id, version);
  if (!deliveryId) {
    const status = await getWebhookDeliveryStatus(pool, rule.id, trace.id, version);
    const delivered = status === "delivered" || status === "covered";
    if (scannerClaimId) {
      await (delivered
        ? markWebhookCovered(pool, scannerClaimId)
        : markWebhookFailed(pool, scannerClaimId, "not sent: another run holds this version"));
    }
    return delivered ? "already-delivered" : "in-flight";
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
    // publicFetch checks each connection's address again, so DNS rebinding after the guard is refused too.
    const fetchImpl = options.fetchImpl ?? (options.allowPrivateDestinations ? fetch : publicFetch);
    const response = await fetchImpl(rule.destinationUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ironside-signature": `sha256=${signature}`
      },
      body,
      // The SSRF guard checked this URL only; a redirect could lead anywhere.
      redirect: "manual",
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
    // Released, so whichever worker retries first may send it.
    if (scannerClaimId) await markWebhookFailed(pool, scannerClaimId, message);
    return { error: message };
  }

  // The HTTP delivery itself succeeded — the destination has already
  // received and processed this webhook, a real non-idempotent side
  // effect. A failure here is a bookkeeping problem, not a delivery
  // problem: it must NOT be treated as retryable (markWebhookFailed
  // would let a future run send a genuine duplicate). Let it propagate
  // so the caller/ops sees "delivered but failed to record" distinctly.
  await markWebhookDelivered(pool, deliveryId);
  if (scannerClaimId) await markWebhookCovered(pool, scannerClaimId);
  return "delivered";
}
