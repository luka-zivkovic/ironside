import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";
import type { Context, Next } from "hono";
import type { AuthEnv } from "./middleware/auth.js";

// Prometheus metrics for the API process (M9-02). Instance-level only —
// deliberately NO per-project labels: project ids are unbounded
// cardinality (a Prometheus anti-pattern) and would leak tenant existence
// to whoever can scrape. Per-project usage questions are ClickHouse's
// job, not the metrics endpoint's.

export interface ApiMetrics {
  registry: Registry;
  /** Hono middleware recording request count + duration per matched route. */
  middleware: (c: Context<AuthEnv>, next: Next) => Promise<void>;
}

export function createApiMetrics(): ApiMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const requestsTotal = new Counter({
    name: "ironside_http_requests_total",
    help: "HTTP requests handled, by matched route pattern, method, and status code",
    labelNames: ["route", "method", "status"] as const,
    registers: [registry]
  });

  const requestDuration = new Histogram({
    name: "ironside_http_request_duration_seconds",
    help: "HTTP request duration by matched route pattern and method",
    labelNames: ["route", "method"] as const,
    // Ingest ACKs sit in the 5-50ms band under normal load (measured in
    // load/heavy-burst.mjs runs); the tail buckets exist to make a
    // degradation visible, not because it's expected.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry]
  });

  async function middleware(c: Context<AuthEnv>, next: Next): Promise<void> {
    const start = performance.now();
    try {
      await next();
    } finally {
      // routePath is the REGISTERED pattern (for example a project trace detail route), not the
      // raw URL — bounded label cardinality even with unbounded ids. For a
      // request no route handler matched, Hono reports THIS middleware's
      // own "*" registration ("/*"), never undefined — the same is true
      // for requests short-circuited before the route layer (bodyLimit
      // 413s, CORS preflights). All three collapse into one "unmatched"
      // label rather than exposing the misleading "/*" (verified
      // empirically in review; a `?? "unmatched"` fallback alone is dead
      // code since routePath is never undefined here).
      const routePath = c.req.routePath;
      const route = routePath === "/*" ? "unmatched" : routePath;
      const durationSeconds = (performance.now() - start) / 1000;
      requestsTotal.inc({ route, method: c.req.method, status: String(c.res.status) });
      requestDuration.observe({ route, method: c.req.method }, durationSeconds);
    }
  }

  return { registry, middleware };
}
