import { createIngestQueue } from "@ironside/queue";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createWorkerMetrics } from "../src/metrics.js";

// Worker metrics (M9-02): the counters, the scrape-time queue-depth
// gauges (sampled from the real Redis-backed queue), and the dedicated
// HTTP listener's token gating.

const config = loadConfig();
const queue = createIngestQueue(config.redisUrl);

afterAll(async () => {
  await queue.close();
});

async function scrape(port: number, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/metrics`, {
    ...(token && { headers: { authorization: `Bearer ${token}` } })
  });
}

function freePort(): number {
  // High ephemeral-range port per test invocation to avoid collisions
  // across parallel test files sharing this machine.
  return 20000 + Math.floor(Math.random() * 20000);
}

describe("createWorkerMetrics", () => {
  it("serves counters and queue-depth gauges over its own HTTP listener", async () => {
    const metrics = createWorkerMetrics(queue);
    metrics.batchesProcessed.inc();
    metrics.batchesProcessed.inc();
    metrics.batchesFailed.inc();
    metrics.batchesRecovered.inc(3);
    metrics.schedulerRuns.inc({ subsystem: "export", outcome: "success" });
    metrics.schedulerRuns.inc({ subsystem: "webhook", outcome: "error" });
    metrics.environmentRegistryOverflow.inc({ source: "live" }, 3);

    const port = freePort();
    const server = metrics.serve(port, null);
    try {
      const res = await scrape(port);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toMatch(/ironside_worker_batches_processed_total 2/);
      expect(body).toMatch(/ironside_worker_batches_failed_total 1/);
      expect(body).toMatch(/ironside_ingest_batches_recovered_total 3/);
      expect(body).toMatch(/ironside_scheduler_runs_total\{subsystem="export",outcome="success"\} 1/);
      expect(body).toMatch(/ironside_scheduler_runs_total\{subsystem="webhook",outcome="error"\} 1/);
      expect(body).toMatch(/ironside_environment_registry_overflow_total\{source="live"\} 3/);
      // Queue-depth gauges sampled live from the real queue at scrape time.
      expect(body).toContain("ironside_ingest_queue_waiting");
      expect(body).toContain("ironside_ingest_queue_active");
      expect(body).toContain("ironside_ingest_queue_failed");
      // Default process metrics exported too.
      expect(body).toContain("process_cpu_user_seconds_total");
    } finally {
      server.close();
    }
  });

  it("gates the listener behind a bearer token when one is configured", async () => {
    const metrics = createWorkerMetrics(queue);
    const port = freePort();
    const server = metrics.serve(port, "worker-scrape-secret");
    try {
      expect((await scrape(port)).status).toBe(401);
      expect((await scrape(port, "wrong")).status).toBe(401);
      expect((await scrape(port, "worker-scrape-secret")).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("a bind failure (port already in use) does not crash the process — regression: an unhandled 'error' event on listen() would take down the whole worker over the least important surface", async () => {
    const metricsA = createWorkerMetrics(queue);
    const metricsB = createWorkerMetrics(queue);
    const port = freePort();
    const serverA = metricsA.serve(port, null);
    // Wait for A to actually bind before provoking the conflict.
    await new Promise<void>((resolve) => serverA.once("listening", resolve));
    const serverB = metricsB.serve(port, null); // EADDRINUSE
    try {
      // Give B's error event a beat to fire; if it were unhandled the
      // test process itself would die here.
      await new Promise((resolve) => setTimeout(resolve, 100));
      // A still serves fine.
      expect((await scrape(port)).status).toBe(200);
    } finally {
      serverA.close();
      serverB.close();
    }
  });

  it("404s anything that isn't GET /metrics", async () => {
    const metrics = createWorkerMetrics(queue);
    const port = freePort();
    const server = metrics.serve(port, null);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: "POST" })).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
