import { createServer, type Server } from "node:http";
import type { Queue } from "bullmq";
import type { QueueMessage } from "@ironside/shared";
import { collectDefaultMetrics, Counter, Gauge, Registry } from "prom-client";

// Prometheus metrics for the worker process (M9-02). The worker has no
// HTTP surface of its own, so this starts a dedicated metrics listener —
// standard practice for queue consumers (each process exports its own
// /metrics). The port is NOT published in docker-compose by default; a
// self-hoster opts in by mapping it and (recommended) setting
// METRICS_TOKEN. Same no-per-project-labels rule as the API's metrics:
// instance-level only, bounded cardinality.

export interface WorkerMetrics {
  registry: Registry;
  batchesProcessed: Counter;
  batchesFailed: Counter;
  eventsDeadLettered: Counter;
  batchesRecovered: Counter;
  schedulerRuns: Counter<"subsystem" | "outcome">;
  environmentRegistryOverflow: Counter<"source">;
  /** Starts the /metrics HTTP listener. Returns the server for shutdown. */
  serve(port: number, token: string | null): Server;
}

export function createWorkerMetrics(queue: Queue<QueueMessage>): WorkerMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const batchesProcessed = new Counter({
    name: "ironside_worker_batches_processed_total",
    help: "Ingest batches successfully processed",
    registers: [registry]
  });
  const batchesFailed = new Counter({
    name: "ironside_worker_batches_failed_total",
    help: "Ingest batch jobs that failed (will be retried up to the queue's attempt limit)",
    registers: [registry]
  });
  const eventsDeadLettered = new Counter({
    name: "ironside_ingest_events_dead_lettered_total",
    help: "Individual ingest events that could not be mapped and were dead-lettered to ingest_event_failures (the rest of their batch still inserted)",
    registers: [registry]
  });
  const batchesRecovered = new Counter({
    name: "ironside_ingest_batches_recovered_total",
    help: "Durable pending ingest batches re-enqueued after queue reconciliation",
    registers: [registry]
  });
  const schedulerRuns = new Counter({
    name: "ironside_scheduler_runs_total",
    help: "Scheduled runs by subsystem (export/otlp-forward/webhook/import/environment-registry/retention) and outcome",
    labelNames: ["subsystem", "outcome"] as const,
    registers: [registry]
  });
  const environmentRegistryOverflow = new Counter({
    name: "ironside_environment_registry_overflow_total",
    help: "Valid novel environment values omitted from bounded discovery, by live observation or rebuild (never labeled by project/value)",
    labelNames: ["source"] as const,
    registers: [registry]
  });

  // Queue depth is sampled at scrape time (prom-client's async collect),
  // not on a timer — always current, zero background work between scrapes.
  new Gauge({
    name: "ironside_ingest_queue_waiting",
    help: "Ingest jobs waiting in the queue (not yet claimed by a worker)",
    registers: [registry],
    async collect() {
      this.set(await queue.getWaitingCount());
    }
  });
  new Gauge({
    name: "ironside_ingest_queue_active",
    help: "Ingest jobs currently being processed",
    registers: [registry],
    async collect() {
      this.set(await queue.getActiveCount());
    }
  });
  new Gauge({
    name: "ironside_ingest_queue_failed",
    help: "Ingest jobs in the failed state (exhausted retries or awaiting retry)",
    registers: [registry],
    async collect() {
      this.set(await queue.getFailedCount());
    }
  });

  function serve(port: number, token: string | null): Server {
    const server = createServer((req, res) => {
      void (async () => {
        if (req.url !== "/metrics" || req.method !== "GET") {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        if (token && req.headers.authorization !== `Bearer ${token}`) {
          res.statusCode = 401;
          res.end("unauthorized");
          return;
        }
        try {
          const body = await registry.metrics();
          res.statusCode = 200;
          res.setHeader("content-type", registry.contentType);
          res.end(body);
        } catch (error) {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : "metrics collection failed");
        }
      })();
    });
    // A bind failure (EADDRINUSE etc.) must NOT crash the worker — an
    // unhandled 'error' event becomes an uncaughtException that would
    // take down the ingest consumer and scheduler over the LEAST
    // important surface in the process. Log and run without metrics
    // instead (review-flagged; verified that listen() on a taken port
    // otherwise kills the process).
    server.on("error", (error) => {
      console.error(`[metrics] listener failed on port ${port} — continuing without metrics:`, error);
    });
    server.listen(port);
    // Never keep the process alive on its own — mirrors the scheduler's
    // timers; the ingest worker is what keeps the process running.
    server.unref();
    return server;
  }

  return {
    registry,
    batchesProcessed,
    batchesFailed,
    eventsDeadLettered,
    batchesRecovered,
    schedulerRuns,
    environmentRegistryOverflow,
    serve
  };
}
