import { runMigrations as runPgMigrations } from "@ironside/db";
import { createClickHouseClient, runMigrations as runChMigrations } from "@ironside/clickhouse";
import { createIngestQueue } from "@ironside/queue";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

// GET /metrics (M9-02): disabled entirely without a configured token
// (404, indistinguishable from no-such-route), token-gated when
// configured, and actually recording request counts/durations per
// matched route pattern.

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

const baseDeps = {
  pgPool: pool,
  clickhouse,
  redis,
  storage,
  queue,
  webOrigins: ["http://localhost:5174"],
  defaultRateLimitPerMinute: 10000
};

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();
});

afterAll(async () => {
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

describe("GET /metrics", () => {
  it("returns 404 when METRICS_TOKEN is not configured — the endpoint doesn't exist, not just 'unauthorized'", async () => {
    const app = createApp({ ...baseDeps, metricsToken: null });
    const res = await app.request("/metrics");
    expect(res.status).toBe(404);
  });

  it("rejects a missing or wrong token with 401 when configured", async () => {
    const app = createApp({ ...baseDeps, metricsToken: "scrape-secret" });
    expect((await app.request("/metrics")).status).toBe(401);
    expect(
      (
        await app.request("/metrics", {
          headers: { authorization: "Bearer wrong-token" }
        })
      ).status
    ).toBe(401);
  });

  it("serves Prometheus text with the correct token, including request counts labeled by MATCHED ROUTE PATTERN (bounded cardinality), not raw URL", async () => {
    const app = createApp({ ...baseDeps, metricsToken: "scrape-secret" });

    // Generate some traffic first: a health hit and an unauthenticated
    // trace-detail hit with a unique id — the metrics label must be the
    // registered pattern, never the raw id.
    await app.request("/health");
    await app.request("/api/v1/projects/proj_metrics/traces/some-unique-trace-id-12345");

    const res = await app.request("/metrics", {
      headers: { authorization: "Bearer scrape-secret" }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();

    expect(body).toContain("ironside_http_requests_total");
    expect(body).toContain("ironside_http_request_duration_seconds");
    // Default process metrics are exported too.
    expect(body).toContain("process_cpu_user_seconds_total");
    // Route label is the pattern, and the raw unbounded id never appears.
    expect(body).toContain('route="/health"');
    expect(body).not.toContain("some-unique-trace-id-12345");
  });

  it("labels unmatched requests 'unmatched', not the middleware's own '/*' pattern — regression: routePath is never undefined for a 404 (it reports the metrics middleware's '*' registration), so a `?? fallback` alone was dead code", async () => {
    const app = createApp({ ...baseDeps, metricsToken: "scrape-secret" });
    await app.request("/no/such/route/abc123");
    await app.request("/another/missing/xyz789");

    const res = await app.request("/metrics", {
      headers: { authorization: "Bearer scrape-secret" }
    });
    const body = await res.text();
    expect(body).toMatch(/ironside_http_requests_total\{route="unmatched",method="GET",status="404"\} 2/);
    expect(body).not.toContain('route="/*"');
    // The raw unmatched paths never become labels (bounded cardinality).
    expect(body).not.toContain("abc123");
  });

  it("counts requests rejected before the route layer (e.g. auth 401s), since the middleware is registered first", async () => {
    const app = createApp({ ...baseDeps, metricsToken: "scrape-secret" });
    await app.request("/api/v1/ingest", { method: "POST" }); // no auth header -> 401

    const res = await app.request("/metrics", {
      headers: { authorization: "Bearer scrape-secret" }
    });
    const body = await res.text();
    expect(body).toMatch(/ironside_http_requests_total\{[^}]*status="401"[^}]*\} [1-9]/);
  });
});
