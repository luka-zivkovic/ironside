import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
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

// Bind on port 0 so the OS hands out a free port, and wait until the
// listener is up before using it. A random fixed port can already be
// taken (often by an outbound socket from a parallel test file): serve()
// then logs EADDRINUSE and carries on without a listener, and the
// request fails with ECONNREFUSED.
async function listening(server: Server): Promise<number> {
  if (!server.listening) await once(server, "listening");
  return (server.address() as AddressInfo).port;
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

    const server = metrics.serve(0, null);
    const port = await listening(server);
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
    const server = metrics.serve(0, "worker-scrape-secret");
    const port = await listening(server);
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
    const serverA = metricsA.serve(0, null);
    // Wait for A to actually bind before provoking the conflict.
    const port = await listening(serverA);
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
    const server = metrics.serve(0, null);
    const port = await listening(server);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: "POST" })).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
