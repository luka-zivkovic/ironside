import { createClickHouseClient, runMigrations as runChMigrations } from "@ironside/clickhouse";
import {
  closeEvaluatorLifecycleFence,
  runMigrations as runPgMigrations
} from "@ironside/db";
import { createIngestQueue, createIngestWorker } from "@ironside/queue";
import { createObjectStorage } from "@ironside/storage";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { createWorkerMetrics } from "./metrics.js";
import {
  createIngestProcessor,
  recoverTerminalEvaluatorTraceRefs,
  settlePublishedEvaluatorTraceRefs
} from "./processors/ingest.js";
import { startPendingIngestRecovery } from "./recovery/recovery-loop.js";
import { verifyPendingIngestStorage } from "./recovery/storage-permissions.js";
import { startScheduler } from "./scheduler.js";

const config = loadConfig();

const pgPool = new Pool({ connectionString: config.databaseUrl });
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);

await runPgMigrations(pgPool);
await runChMigrations(clickhouse);
await storage.ensureBucket();
await verifyPendingIngestStorage(storage);

// A Queue handle (producer-side API) alongside the Worker consumer — the
// metrics gauges sample queue depth via Queue.getWaitingCount() etc.,
// which the Worker class doesn't expose.
const queue = createIngestQueue(config.redisUrl);
const metrics = createWorkerMetrics(queue);

const worker = createIngestWorker(
  config.redisUrl,
  createIngestProcessor({
    storage,
    clickhouse,
    pool: pgPool,
    retentionExecutionEnabled: config.rawRetentionExecutionEnabled,
    onDeadLetter: (count) => metrics.eventsDeadLettered.inc(count),
    onEnvironmentRegistryOverflow: (count) =>
      metrics.environmentRegistryOverflow.inc({ source: "live" }, count)
  })
);

worker.on("completed", (job) => {
  metrics.batchesProcessed.inc();
  console.log(`[ingest] batch=${job.data.batchId} processed`);
});
worker.on("failed", (job, err) => {
  metrics.batchesFailed.inc();
  console.error(`[ingest] batch=${job?.data.batchId} failed:`, err);
  if (job) {
    void settlePublishedEvaluatorTraceRefs(
      { storage, clickhouse, pool: pgPool },
      job.data
    ).catch((recoveryError) => {
      console.error(
        `[ingest] batch=${job.data.batchId} failed to settle its committed evaluator publication:`,
        recoveryError
      );
    });
  }
});

console.log("ironside-worker: ingest consumer running");

const recovery = startPendingIngestRecovery({
  storage,
  queue,
  pool: pgPool,
  retentionExecutionEnabled: config.rawRetentionExecutionEnabled,
  intervalMs: config.ingestRecoveryIntervalMs,
  batchSize: config.ingestRecoveryBatchSize,
  beforeTerminalFailure: (message) =>
    recoverTerminalEvaluatorTraceRefs(
      { storage, clickhouse, pool: pgPool },
      message
    ),
  onResult: (result) => {
    const recovered = result.enqueued;
    if (recovered > 0) {
      metrics.batchesRecovered.inc(recovered);
      console.log(`[ingest-recovery] recovered=${recovered} examined=${result.examined}`);
    }
    metrics.schedulerRuns.inc({ subsystem: "ingest-recovery", outcome: "success" });
  },
  onError: (error) => {
    metrics.schedulerRuns.inc({ subsystem: "ingest-recovery", outcome: "error" });
    console.error("[ingest-recovery] reconciliation failed:", error);
  }
});
console.log("ironside-worker: ingest recovery running");

// Drives scheduled exports, OTLP forwards, webhooks, and retention — see
// scheduler.ts for why a plain interval loop (not a second BullMQ queue)
// is sufficient here.
const scheduler = startScheduler({
  pool: pgPool,
  clickhouse,
  defaultRetentionDays: config.defaultRetentionDays,
  defaultTraceQuietPeriodSeconds: config.defaultTraceQuietPeriodSeconds,
  tickIntervalMs: config.schedulerTickIntervalMs,
  retentionIntervalMs: config.retentionIntervalMs,
  onRunOutcome: (subsystem, outcome) => metrics.schedulerRuns.inc({ subsystem, outcome }),
  onEnvironmentRegistryOverflow: (source, count) =>
    metrics.environmentRegistryOverflow.inc({ source }, count)
});
console.log("ironside-worker: scheduler running");

const metricsServer = metrics.serve(config.metricsPort, config.metricsToken);
console.log(`ironside-worker: metrics on :${config.metricsPort}/metrics`);

async function shutdown(): Promise<void> {
  scheduler.stop();
  recovery.stop();
  metricsServer.close();
  await worker.close();
  await queue.close();
  await closeEvaluatorLifecycleFence(pgPool);
  await pgPool.end();
  await clickhouse.close();
  storage.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
