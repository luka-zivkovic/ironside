import type { ObjectStorage } from "@ironside/storage";
import type { QueueMessage } from "@ironside/shared";
import { DEFAULT_TRACE_QUIET_PERIOD_SECONDS } from "@ironside/shared";
import type { Queue } from "bullmq";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { HealthDeps } from "./health.js";
import { checkHealth } from "./health.js";
import { createApiMetrics } from "./metrics.js";
import type { AuthEnv } from "./middleware/auth.js";
import { machineAuth } from "./middleware/auth.js";
import {
  ownerProjectAuth,
  ownerSessionAuth,
  trustedBrowserMutation,
  type OwnerProjectEnv
} from "./middleware/owner-session.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { exportsRoutes } from "./routes/exports.js";
import { forwardsRoutes } from "./routes/forwards.js";
import { importSourcesRoutes } from "./routes/import-sources.js";
import { ingestFailuresRoutes } from "./routes/ingest-failures.js";
import { mediaReadRoutes, mediaUploadRoutes } from "./routes/media.js";
import { ingestRoutes } from "./routes/ingest.js";
import { credentialsRoutes } from "./routes/credentials.js";
import { environmentsRoutes } from "./routes/environments.js";
import { evaluatorReadRoutes, evaluatorScoreRoutes } from "./routes/evaluator.js";
import { langfuseFetchRoutes } from "./routes/langfuse-fetch.js";
import { langfuseRoutes } from "./routes/langfuse.js";
import { otlpRoutes } from "./routes/otlp.js";
import { projectQuotasRoutes, projectsRoutes } from "./routes/projects.js";
import { rawEventsRoutes } from "./routes/raw-events.js";
import { tracesRoutes } from "./routes/traces.js";
import { webhookRulesRoutes } from "./routes/webhooks.js";
import { ownerAuthRoutes } from "./routes/owner-auth.js";

export interface AppDeps extends HealthDeps {
  storage: ObjectStorage;
  queue: Queue<QueueMessage>;
  /** Origins apps/web (or any other browser client) is allowed to call this API from. */
  webOrigins: string[];
  /** Secure by default; false is an explicit plain-HTTP local/LAN opt-out. */
  authSecureCookies?: boolean;
  authSessionIdleTtlSeconds?: number;
  authSessionAbsoluteTtlSeconds?: number;
  authRateLimitPerWindow?: number;
  authTrustProxy?: boolean;
  /** Platform-default per-project ingest rate limit (requests/minute). */
  defaultRateLimitPerMinute: number;
  /** Platform-default trace completion quiet period, overridable per project. */
  defaultTraceQuietPeriodSeconds?: number;
  /** Bearer token gating GET /metrics; null/undefined disables the endpoint entirely (404). */
  metricsToken?: string | null;
  /** Per-project limit for the raw-events lookup (requests/minute). Defaults to RAW_EVENTS_RATE_LIMIT_PER_MINUTE. */
  rawEventsRateLimitPerMinute?: number;
}

// Caps request body size on every route, ingest included. Without this a
// client (malicious or buggy) can send an arbitrarily large or deeply
// nested JSON body — e.g. a pathologically nested OTLP attribute
// arrayValue/kvlistValue chain — and exhaust memory or, for a recursive
// Zod schema, blow the call stack during parsing, before validation ever
// gets a chance to reject it on shape. 10MB comfortably fits the largest
// realistic single ingest/OTLP batch (MAX_EVENTS_PER_BATCH=500 native
// events, or one OTLP export) with headroom.
// Exported because the OTLP route re-applies it to DECOMPRESSED gzip
// bodies — bodyLimit only counts wire bytes, and gzip hits ~1000:1 on
// repetitive input, so a 200KB compressed body can be a 200MB bomb.
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

// The raw-events lookup is a GET, but nothing like the other query routes:
// one request can fan out into hundreds of S3 LIST/GET calls, so it gets
// its own — much stricter than ingest — per-project limit. 30/min is
// generous for the human/debugging usage the endpoint exists for while
// keeping a scripted loop from turning into an object-storage bill.
const RAW_EVENTS_RATE_LIMIT_PER_MINUTE = 30;

export function createApp(deps: AppDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // Registered FIRST, so it wraps every later middleware and route — a
  // request rejected by bodyLimit (413) or answered by the CORS preflight
  // handler still gets counted; a later registration would miss anything
  // that short-circuits before it.
  const metrics = createApiMetrics();
  app.use("*", metrics.middleware);

  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c) => c.json({ error: "request body too large" }, 413)
    })
  );

  // Owner sessions use HttpOnly cookies. Credentialed CORS remains locked to
  // the exact configured web origins; state-changing session routes add their
  // own Origin + Fetch Metadata checks below. Bearer clients are unaffected.
  app.use(
    "*",
    cors({
      origin: deps.webOrigins,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
      maxAge: 600
    })
  );

  app.get("/health", async (c) => {
    const report = await checkHealth(deps);
    return c.json(
      { service: "ironside-api", ...report },
      report.status === "ok" ? 200 : 503
    );
  });

  // Instance-level Prometheus metrics. Never exposed unauthenticated on
  // the public API port: disabled entirely (404, indistinguishable from
  // no-such-route) unless METRICS_TOKEN is configured, and then requires
  // exactly that token — deliberately NOT project machine credentials,
  // since metrics are instance-wide and one project shouldn't see cross-tenant
  // request rates.
  app.get("/metrics", async (c) => {
    if (!deps.metricsToken) {
      return c.json({ error: "not found" }, 404);
    }
    const auth = c.req.header("authorization");
    if (auth !== `Bearer ${deps.metricsToken}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.text(await metrics.registry.metrics(), 200, {
      "content-type": metrics.registry.contentType
    });
  });

  // Human control-plane identity is deliberately separate from project API
  // keys. These routes are mounted outside the bearer-authenticated groups so
  // a machine credential can neither establish nor resume an owner session.
  app.route(
    "/api/auth",
    ownerAuthRoutes({
      pool: deps.pgPool,
      redis: deps.redis,
      webOrigins: deps.webOrigins,
      secureCookies: deps.authSecureCookies ?? true,
      sessionIdleTtlSeconds: deps.authSessionIdleTtlSeconds ?? 12 * 60 * 60,
      sessionAbsoluteTtlSeconds: deps.authSessionAbsoluteTtlSeconds ?? 7 * 24 * 60 * 60,
      rateLimitPerWindow: deps.authRateLimitPerWindow ?? 10,
      trustProxy: deps.authTrustProxy ?? false
    })
  );

  const ownerSessionOptions = {
    idleTtlSeconds: deps.authSessionIdleTtlSeconds ?? 12 * 60 * 60,
    secureCookies: deps.authSecureCookies ?? true
  };

  const rateLimitOptions = {
    defaultLimit: deps.defaultRateLimitPerMinute,
    windowSeconds: 60,
    pool: deps.pgPool
  };

  // Browser/control-plane APIs use only the owner session. Their project is
  // explicit in the URL and resolved through one authorization chokepoint;
  // machine keys never reach this router and therefore cannot choose or probe
  // another project.
  const ownerProjects = new Hono<OwnerProjectEnv>();
  ownerProjects.use("*", ownerSessionAuth(deps.pgPool, ownerSessionOptions));
  ownerProjects.use("*", trustedBrowserMutation(deps.webOrigins));
  ownerProjects.route("/", projectsRoutes({ pool: deps.pgPool }));

  const ownerProject = new Hono<OwnerProjectEnv>();
  ownerProject.use("*", ownerProjectAuth(deps.pgPool));
  ownerProject.route("/", projectQuotasRoutes({ pool: deps.pgPool }));
  ownerProject.route("/", tracesRoutes({ clickhouse: deps.clickhouse }));
  ownerProject.route("/", credentialsRoutes({ pool: deps.pgPool, redis: deps.redis }));
  ownerProject.route("/", environmentsRoutes({ pool: deps.pgPool }));
  ownerProject.route("/", exportsRoutes({ pool: deps.pgPool }));
  ownerProject.route("/", forwardsRoutes({ pool: deps.pgPool }));
  ownerProject.route("/", webhookRulesRoutes({ pool: deps.pgPool }));
  ownerProject.route("/", importSourcesRoutes({ pool: deps.pgPool }));
  ownerProject.route("/", ingestFailuresRoutes({ pool: deps.pgPool }));
  ownerProject.route("/", mediaReadRoutes({ pool: deps.pgPool, storage: deps.storage }));
  ownerProject.use(
    "/traces/:id/raw-events",
    rateLimit(deps.redis, {
      defaultLimit: deps.rawEventsRateLimitPerMinute ?? RAW_EVENTS_RATE_LIMIT_PER_MINUTE,
      windowSeconds: 60,
      pool: deps.pgPool,
      scope: "raw-events",
      useProjectOverride: false
    })
  );
  ownerProject.route("/", rawEventsRoutes({ clickhouse: deps.clickhouse, storage: deps.storage }));
  ownerProjects.route("/:projectId", ownerProject);
  app.route("/api/v1/projects", ownerProjects);

  // Rate limiting applies only to the write/ingest paths (native ingest,
  // OTLP, LangFuse compat) plus the raw-events scan (own group below) —
  // not to owner-session reads or management routes. Machine credentials are
  // deliberately limited here to stable key-implicit data-plane contracts.
  // Hono's trailing wildcard matches both the base path and descendants.
  const v1 = new Hono<AuthEnv>();
  v1.use("/media/*", machineAuth(deps.pgPool, deps.redis, "media:write"));
  v1.use("/media/*", rateLimit(deps.redis, rateLimitOptions));
  v1.route("/", mediaUploadRoutes({ pool: deps.pgPool, storage: deps.storage }));
  app.route("/api/v1", v1);

  const v1Ingest = new Hono<AuthEnv>();
  v1Ingest.use("/ingest/*", machineAuth(deps.pgPool, deps.redis, "ingest"));
  v1Ingest.use("/ingest/*", rateLimit(deps.redis, rateLimitOptions));
  v1Ingest.route("/", ingestRoutes({ storage: deps.storage, queue: deps.queue }));
  app.route("/api/v1", v1Ingest);

  // OTLP endpoints are conventionally top-level (/v1/otel/*), not nested
  // under /api/v1 — matches the path shape OTel exporters expect and how
  // LangFuse/LangSmith expose their own OTLP ingest separately from their
  // native API namespace.
  const otel = new Hono<AuthEnv>();
  otel.use("/otel/traces/*", machineAuth(deps.pgPool, deps.redis, "ingest"));
  otel.use("/otel/traces/*", rateLimit(deps.redis, rateLimitOptions));
  otel.route("/", otlpRoutes({ storage: deps.storage, queue: deps.queue }));
  app.route("/v1", otel);

  // Native evaluator integration. Unlike the operator's project-explicit
  // live trace view, this key-implicit machine feed exposes settled versions
  // only and derives the project exclusively from the Integration credential.
  const evaluatorRead = new Hono<AuthEnv>();
  const evaluatorTraceAuth = machineAuth(deps.pgPool, deps.redis, "traces:read");
  evaluatorRead.use("/evaluator/*", async (c, next) => {
    // This router is mounted before the score writer. Do not accidentally
    // make POST /evaluator/scores require traces:read in addition to its own
    // scores:write capability merely because the path shares a prefix.
    if (c.req.method !== "GET") return next();
    return evaluatorTraceAuth(c, next);
  });
  evaluatorRead.route(
    "/",
    evaluatorReadRoutes({
      clickhouse: deps.clickhouse,
      pool: deps.pgPool,
      defaultTraceQuietPeriodSeconds:
        deps.defaultTraceQuietPeriodSeconds ?? DEFAULT_TRACE_QUIET_PERIOD_SECONDS
    })
  );
  app.route("/api/v1", evaluatorRead);

  const evaluatorScore = new Hono<AuthEnv>();
  evaluatorScore.use("/evaluator/scores/*", machineAuth(deps.pgPool, deps.redis, "scores:write"));
  evaluatorScore.use("/evaluator/scores/*", rateLimit(deps.redis, rateLimitOptions));
  evaluatorScore.route("/", evaluatorScoreRoutes({ storage: deps.storage, queue: deps.queue }));
  app.route("/api/v1", evaluatorScore);

  // LangFuse compat reads: GET /api/public/traces[/:id] — LangFuse's own
  // fetch API paths, consumed by coeval's poller (M8) and any other
  // LangFuse-reading client. Mounted BEFORE the write group so Hono
  // resolves the GETs here; no rate limit, matching the native query
  // routes' convention above.
  const langfuseFetch = new Hono<AuthEnv>();
  langfuseFetch.use("/public/traces/*", machineAuth(deps.pgPool, deps.redis, "traces:read"));
  langfuseFetch.route(
    "/",
    langfuseFetchRoutes({
      clickhouse: deps.clickhouse,
      pool: deps.pgPool,
      defaultTraceQuietPeriodSeconds:
        deps.defaultTraceQuietPeriodSeconds ?? DEFAULT_TRACE_QUIET_PERIOD_SECONDS
    })
  );
  app.route("/api", langfuseFetch);

  // LangFuse compat writes: /api/public/ingestion is LangFuse's own
  // endpoint URL (not Ironside's /api/v1/* convention) — matching it
  // exactly is the whole point, so a client pointing LANGFUSE_BASEURL at
  // this host works with zero code changes. /api/public/scores (M8) is
  // coeval's verdict sync-back target.
  const langfuseCompat = new Hono<AuthEnv>();
  langfuseCompat.use("/public/ingestion/*", machineAuth(deps.pgPool, deps.redis, "ingest"));
  langfuseCompat.use("/public/scores/*", machineAuth(deps.pgPool, deps.redis, "scores:write"));
  langfuseCompat.use("/public/ingestion/*", rateLimit(deps.redis, rateLimitOptions));
  langfuseCompat.use("/public/scores/*", rateLimit(deps.redis, rateLimitOptions));
  langfuseCompat.route("/", langfuseRoutes({ storage: deps.storage, queue: deps.queue }));
  app.route("/api", langfuseCompat);

  return app;
}
