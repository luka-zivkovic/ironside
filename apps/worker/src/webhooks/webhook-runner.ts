import { createHmac } from "node:crypto";
import { exportTraces, type ClickHouseClient } from "@ironside/clickhouse";
import { claimWebhookDelivery, markWebhookDelivered, markWebhookFailed, type WebhookRule } from "@ironside/db";
import type { Pool } from "pg";
import { ulid } from "ulid";
import { traceSettledBefore } from "@ironside/shared";
import { assertPublicHttpDestination } from "../lib/ssrf-guard.js";

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
}

export interface WebhookRunResult {
  matched: number;
  delivered: number;
  /** This settled version was already delivered, or is concurrently in flight — correctly skipped, not an error. */
  skipped: number;
  failed: { traceId: string; error: string }[];
}

interface WebhookPayload {
  event: "trace.matched";
  traceId: string;
  projectId: string;
  timestamp: string;
  name: string | null;
  /** Latest activity timestamp for this settled snapshot. */
  traceVersion: string;
}

/**
 * Delivers a webhook POST for every currently-matching settled trace version
 * that has not already been successfully delivered — the "fires exactly once
 * per matching settled version" guarantee. Enforced by claimWebhookDelivery's atomic
 * INSERT ... ON CONFLICT (see packages/db/src/webhooks.ts), not by
 * checking-then-sending here: the claim happens BEFORE the HTTP request,
 * so even if this function is invoked twice concurrently (or a job
 * retries after a delivered-but-response-lost webhook), only one call can
 * ever hold the claim for a given (rule, trace, version) tuple. A failed delivery
 * releases the version for retry on a future run; a successful one never
 * fires again unless later trace/observation activity creates a new version.
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

  let delivered = 0;
  let skipped = 0;
  const failed: { traceId: string; error: string }[] = [];

  for (const summary of summaries) {
    const deliveryId = await claimWebhookDelivery(
      pool,
      ulid(),
      rule.id,
      summary.id,
      summary.last_activity_at
    );
    if (!deliveryId) {
      skipped += 1;
      continue;
    }

    let response: Response;
    const body = JSON.stringify({
      event: "trace.matched",
      traceId: summary.id,
      projectId: rule.projectId,
      timestamp: summary.timestamp,
      name: summary.name,
      traceVersion: summary.last_activity_at
    } satisfies WebhookPayload);
    const signature = createHmac("sha256", options.signingSecret).update(body).digest("hex");

    try {
      response = await fetchImpl(rule.destinationUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ironside-signature": `sha256=${signature}`
        },
        body
      });
      if (!response.ok) {
        throw new Error(`destination responded HTTP ${response.status}`);
      }
    } catch (error) {
      // Only a failed/unconfirmed HTTP attempt is retryable — the
      // destination has not (confirmably) received this webhook yet.
      const message = error instanceof Error ? error.message : String(error);
      await markWebhookFailed(pool, deliveryId, message);
      failed.push({ traceId: summary.id, error: message });
      continue;
    }

    // The HTTP delivery itself succeeded — the destination has already
    // received and processed this webhook, a real non-idempotent side
    // effect. A failure here is a bookkeeping problem, not a delivery
    // problem: it must NOT be treated as retryable (markWebhookFailed
    // would let a future run send a genuine duplicate). Let it propagate
    // so the caller/ops sees "delivered but failed to record" distinctly.
    await markWebhookDelivered(pool, deliveryId);
    delivered += 1;
  }

  return { matched: summaries.length, delivered, skipped, failed };
}
