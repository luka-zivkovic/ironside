import type { ClickHouseClient } from "@ironside/clickhouse";
import {
  claimDueExportConfigs,
  claimDueImportSources,
  claimDueOtlpForwardRules,
  claimDueWebhookRules,
  claimDueEnvironmentRegistryRebuilds,
  failEnvironmentRegistryRebuild,
  recordExportRun,
  getProject
} from "@ironside/db";
import { DEFAULT_TRACE_QUIET_PERIOD_SECONDS, decryptSecret } from "@ironside/shared";
import type { Pool } from "pg";
import { runExport } from "./exporters/export-runner.js";
import { forwardOtlpTraces } from "./forwarders/otlp-forwarder.js";
import { runLangfuseImport } from "./importers/langfuse-importer.js";
import { runLangsmithImport } from "./importers/langsmith-importer.js";
import { recoverAbandonedEvaluatorImports } from "./importers/evaluator-publication.js";
import { runRetention } from "./retention/retention-runner.js";
import { runWebhooks } from "./webhooks/webhook-runner.js";
import { runEnvironmentRegistryRebuildChunk } from "./environments/environment-registry.js";

export interface SchedulerOptions {
  pool: Pool;
  clickhouse: ClickHouseClient;
  /** Platform-default ClickHouse retention window in days, passed straight through to runRetention. */
  defaultRetentionDays: number;
  /** Platform default used when projects.trace_quiet_period_seconds is null. */
  defaultTraceQuietPeriodSeconds?: number;
  /** How often each subsystem is polled for due work, in ms. */
  tickIntervalMs?: number;
  /** How often runRetention (a global sweep, not a per-row claim) runs, in ms — deliberately much longer than tickIntervalMs, since dropping partitions is not something to attempt every few seconds. */
  retentionIntervalMs?: number;
  /** Max due rows claimed per tick per subsystem — bounds one tick's work so a large backlog doesn't monopolize the worker process indefinitely. */
  claimBatchSize?: number;
  onError?: (subsystem: string, error: unknown) => void;
  /** Called once per scheduled run with its outcome — the metrics hook (M9-02). onError still fires separately with the error itself. */
  onRunOutcome?: (subsystem: string, outcome: "success" | "error") => void;
  onEnvironmentRegistryOverflow?: (
    source: "live" | "rebuild",
    count: number
  ) => void;
}

const DEFAULT_TICK_INTERVAL_MS = 30_000;
const DEFAULT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_CLAIM_BATCH_SIZE = 25;

export interface Scheduler {
  stop(): void;
}

/**
 * Drives the trigger-less-since-first-shipped worker functions
 * (runExport/forwardOtlpTraces/runWebhooks/runRetention) on a timer,
 * closing the "tested, callable function only" gap tracked across M5/M6's
 * specs. Each subsystem's due rows are claimed from Postgres via
 * `FOR UPDATE SKIP LOCKED` (see claimDueExportConfigs et al.) — that
 * claim, not a BullMQ repeatable job, is what makes concurrent ticks (or
 * multiple worker replicas, if ever run that way) safe: a plain
 * setInterval loop is sufficient because the correctness-critical locking
 * already lives at the database layer, not in the scheduling mechanism.
 *
 * One failing row does not stop the tick or crash the process — errors
 * are reported via onError and the loop continues to the next row/tick,
 * matching the "one bad item doesn't fail the whole batch" policy used
 * throughout the ingest pipeline.
 */
export function startScheduler(options: SchedulerOptions): Scheduler {
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const retentionIntervalMs = options.retentionIntervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
  const claimBatchSize = options.claimBatchSize ?? DEFAULT_CLAIM_BATCH_SIZE;
  const onError = options.onError ?? ((subsystem, error) => console.error(`[scheduler:${subsystem}]`, error));
  const onRunOutcome = options.onRunOutcome ?? (() => undefined);
  const defaultTraceQuietPeriodSeconds =
    options.defaultTraceQuietPeriodSeconds ?? DEFAULT_TRACE_QUIET_PERIOD_SECONDS;

  async function traceQuietPeriodSeconds(projectId: string): Promise<number> {
    const project = await getProject(options.pool, projectId);
    return project?.traceQuietPeriodSeconds ?? defaultTraceQuietPeriodSeconds;
  }

  let stopped = false;

  async function tickExports(): Promise<void> {
    const due = await claimDueExportConfigs(options.pool, claimBatchSize);
    for (const config of due) {
      try {
        const secret = decryptSecret(config.destinationSecretAccessKeyEncrypted);
        // runExport already records its own outcome on every path it
        // reaches (empty-result success with rowCount 0, non-empty
        // success, and upload failure) — see export-runner.ts. A second
        // recordExportRun call here on success would not just be
        // redundant, it would actively corrupt the empty-result case:
        // runExport writes rowCount 0, then this call's
        // `outcome.rowCount ?? null` would overwrite it back to null.
        // Only a failure that happens BEFORE runExport reaches any of
        // its own recordExportRun calls (e.g. decryptSecret throwing, or
        // exportTraces itself throwing) has no bookkeeping yet — that's
        // the only case this catch block needs to cover.
        await runExport({
          pool: options.pool,
          clickhouse: options.clickhouse,
          config,
          destinationSecretAccessKey: secret,
          traceQuietPeriodSeconds: await traceQuietPeriodSeconds(config.projectId)
        });
        onRunOutcome("export", "success");
      } catch (error) {
        await recordExportRun(options.pool, config.id, {
          status: "error",
          error: error instanceof Error ? error.message : String(error)
        }).catch(() => undefined); // never let a bookkeeping failure mask the real error below
        onError("export", error);
        onRunOutcome("export", "error");
      }
    }
  }

  async function tickOtlpForwards(): Promise<void> {
    const due = await claimDueOtlpForwardRules(options.pool, claimBatchSize);
    for (const rule of due) {
      try {
        await forwardOtlpTraces({
          clickhouse: options.clickhouse,
          rule,
          traceQuietPeriodSeconds: await traceQuietPeriodSeconds(rule.projectId),
          ...(rule.destinationAuthHeaderEncrypted && {
            destinationAuthHeader: decryptSecret(rule.destinationAuthHeaderEncrypted)
          })
        });
        onRunOutcome("otlp-forward", "success");
      } catch (error) {
        onError("otlp-forward", error);
        onRunOutcome("otlp-forward", "error");
      }
    }
  }

  async function tickWebhooks(): Promise<void> {
    const due = await claimDueWebhookRules(options.pool, claimBatchSize);
    for (const rule of due) {
      try {
        await runWebhooks({
          pool: options.pool,
          clickhouse: options.clickhouse,
          rule,
          signingSecret: decryptSecret(rule.signingSecretEncrypted),
          traceQuietPeriodSeconds: await traceQuietPeriodSeconds(rule.projectId)
        });
        onRunOutcome("webhook", "success");
      } catch (error) {
        onError("webhook", error);
        onRunOutcome("webhook", "error");
      }
    }
  }

  // Unlike exports/forwards/webhooks, the importers already record their
  // OWN outcome on every path they reach — see runLangfuseImport's/
  // runLangsmithImport's own try/catch (markImportRunIdle on success,
  // markImportRunFailed + rethrow on error), the identical pattern
  // runExport already established. This catch block only needs to record
  // a failure for the narrow window BEFORE the importer's own try block
  // ever starts: decrypting/parsing the stored credentials blob.
  async function tickImports(): Promise<void> {
    await recoverAbandonedEvaluatorImports({
      pool: options.pool,
      clickhouse: options.clickhouse,
      limit: claimBatchSize,
      onEnvironmentRegistryOverflow: (count) =>
        options.onEnvironmentRegistryOverflow?.("live", count),
      onError: (_projectId, _source, error) => onError("import-recovery", error)
    });
    const due = await claimDueImportSources(options.pool, claimBatchSize);
    for (const source of due) {
      try {
        // `as` performs no runtime validation — a decrypted-but-malformed
        // blob (missing fields, or a provider value matching neither
        // branch) would otherwise fall through to whichever branch
        // credentials.provider string-compares into, dispatching to the
        // WRONG importer with undefined fields rather than failing
        // cleanly here. Dispatching on source.provider (the trusted DB
        // column) rather than the decrypted blob's own provider field,
        // plus an explicit agreement check, catches both a genuinely
        // malformed blob AND (review-flagged hardening) a decrypted
        // provider that disagrees with the DB row — e.g. under direct DB
        // tampering or an encryption-key mixup, which would otherwise
        // silently run the wrong importer against the wrong project's
        // import_checkpoints row.
        const parsed = JSON.parse(decryptSecret(source.encryptedCredentials)) as {
          provider?: unknown;
          [key: string]: unknown;
        };
        if (parsed.provider !== source.provider) {
          throw new Error(
            `import source ${source.id}: decrypted credentials provider "${String(parsed.provider)}" does not match stored provider "${source.provider}"`
          );
        }

        if (source.provider === "langfuse") {
          const credentials = parsed as unknown as {
            publicKey: string;
            secretKey: string;
            baseUrl: string;
          };
          await runLangfuseImport({
            pool: options.pool,
            clickhouse: options.clickhouse,
            projectId: source.projectId,
            client: {
              baseUrl: credentials.baseUrl,
              publicKey: credentials.publicKey,
              secretKey: credentials.secretKey
            },
            onEnvironmentRegistryOverflow: (count) =>
              options.onEnvironmentRegistryOverflow?.("live", count),
            onInvalidTrace: (traceId, error) =>
              onError(`import:langfuse:${traceId}`, error)
          });
        } else {
          const credentials = parsed as unknown as {
            apiKey: string;
            baseUrl?: string;
            sessionIds: string[];
          };
          await runLangsmithImport({
            pool: options.pool,
            clickhouse: options.clickhouse,
            projectId: source.projectId,
            client: { apiKey: credentials.apiKey, ...(credentials.baseUrl && { baseUrl: credentials.baseUrl }) },
            sessionIds: credentials.sessionIds,
            onInvalidTrace: (traceId, error) =>
              onError(`import:langsmith:${traceId}`, error)
          });
        }
        onRunOutcome("import", "success");
      } catch (error) {
        onError("import", error);
        onRunOutcome("import", "error");
      }
    }
  }

  async function tickEnvironmentRegistry(): Promise<void> {
    const claims = await claimDueEnvironmentRegistryRebuilds(options.pool, claimBatchSize);
    for (const claim of claims) {
      try {
        await runEnvironmentRegistryRebuildChunk({
          pool: options.pool,
          clickhouse: options.clickhouse,
          claim,
          onOverflow: () => options.onEnvironmentRegistryOverflow?.("rebuild", 1)
        });
        onRunOutcome("environment-registry", "success");
      } catch (error) {
        await failEnvironmentRegistryRebuild(
          options.pool,
          claim,
          error instanceof Error ? error.message : String(error)
        ).catch(() => undefined);
        onError("environment-registry", error);
        onRunOutcome("environment-registry", "error");
      }
    }
  }

  async function tickRetention(): Promise<void> {
    try {
      await runRetention({
        pool: options.pool,
        clickhouse: options.clickhouse,
        defaultRetentionDays: options.defaultRetentionDays
      });
      onRunOutcome("retention", "success");
    } catch (error) {
      onError("retention", error);
      onRunOutcome("retention", "error");
    }
  }

  // Fires immediately (don't wait a full tickIntervalMs for the first
  // real run), then on a fixed interval. Each subsystem's own tick is
  // awaited sequentially rather than run concurrently with the others —
  // simpler to reason about at current scale, and none of the four is
  // latency-sensitive enough to need overlapping ticks; a slow tick just
  // pushes the next one later; it doesn't skip claimed work, since
  // claiming already advanced next_run_at.
  //
  // `ticking` prevents setInterval from starting a SECOND concurrent
  // runTick() if one is still in flight past tickIntervalMs. This isn't a
  // correctness requirement — claimDueX's FOR UPDATE SKIP LOCKED already
  // guarantees two concurrent ticks claim disjoint rows, never the same
  // row twice — but without the guard, sustained slowness (e.g. many due
  // rows, or a slow destination) would let ticks pile up unboundedly
  // instead of naturally spacing themselves out.
  let ticking = false;
  async function runTick(): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
      await tickExports();
      await tickOtlpForwards();
      await tickWebhooks();
    } finally {
      ticking = false;
    }
  }

  const tickTimer = setInterval(() => void runTick(), tickIntervalMs);
  tickTimer.unref?.();
  void runTick();

  // Imports run on their OWN timer, separate from the fast exports/
  // forwards/webhooks tick above — a real backfill against an external
  // API can genuinely take minutes (paginated, rate-limited by the
  // source), and runTick's sequential await would otherwise stall
  // exports/forwards/webhooks behind a slow import run every tick.
  // importTicking mirrors `ticking`'s reentrancy guard for the same
  // reason (bounded work per invocation via claimBatchSize, but a
  // slow-source tick shouldn't pile up either).
  let importTicking = false;
  async function runImportTick(): Promise<void> {
    if (stopped || importTicking) return;
    importTicking = true;
    try {
      await tickImports();
    } finally {
      importTicking = false;
    }
  }
  const importTickTimer = setInterval(() => void runImportTick(), tickIntervalMs);
  importTickTimer.unref?.();
  void runImportTick();

  let environmentTicking = false;
  async function runEnvironmentTick(): Promise<void> {
    if (stopped || environmentTicking) return;
    environmentTicking = true;
    try {
      await tickEnvironmentRegistry();
    } catch (error) {
      // Per-claim failures are handled inside tickEnvironmentRegistry. This
      // outer guard covers a failed claim query so the fire-and-forget timer
      // cannot create an unhandled rejection and stop future maintenance.
      onError("environment-registry", error);
      onRunOutcome("environment-registry", "error");
    } finally {
      environmentTicking = false;
    }
  }
  const environmentTickTimer = setInterval(
    () => void runEnvironmentTick(),
    tickIntervalMs
  );
  environmentTickTimer.unref?.();
  void runEnvironmentTick();

  const retentionTimer = setInterval(() => void tickRetention(), retentionIntervalMs);
  retentionTimer.unref?.();
  void tickRetention();

  return {
    stop() {
      stopped = true;
      clearInterval(tickTimer);
      clearInterval(importTickTimer);
      clearInterval(environmentTickTimer);
      clearInterval(retentionTimer);
    }
  };
}
