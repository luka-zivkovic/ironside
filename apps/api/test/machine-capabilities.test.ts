import { runMigrations as runPgMigrations } from "@ironside/db";
import { createClickHouseClient, runMigrations as runChMigrations } from "@ironside/clickhouse";
import { createIngestQueue } from "@ironside/queue";
import { createObjectStorage } from "@ironside/storage";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMachineCredential } from "../src/lib/machine-credentials.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);
const app = createApp({
  pgPool: pool,
  clickhouse,
  redis,
  storage,
  queue,
  webOrigins: ["http://localhost:5174"],
  defaultRateLimitPerMinute: 10000
});

let organizationId: string;
let projectId: string;
let ingestToken: string;
let integrationToken: string;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();
  organizationId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [organizationId, "capability matrix"]);
  await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
    projectId,
    organizationId,
    "capability matrix"
  ]);
  ingestToken = (
    await createMachineCredential(pool, {
      projectId,
      organizationId,
      name: "ingest",
      preset: "ingest",
      expiresAt: null,
      actor: { principalId: null, username: "capability-test" }
    })
  ).token;
  integrationToken = (
    await createMachineCredential(pool, {
      projectId,
      organizationId,
      name: "integration",
      preset: "integration",
      expiresAt: null,
      actor: { principalId: null, username: "capability-test" }
    })
  ).token;
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [organizationId]);
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

function bearer(token: string, contentType?: string) {
  return {
    authorization: `Bearer ${token}`,
    ...(contentType && { "content-type": contentType })
  };
}

function nativeBatch(inlineScore = false) {
  return {
    events: [
      inlineScore
        ? {
            type: "score-upsert",
            body: {
              id: `score_${ulid()}`,
              traceId: `trace_${ulid()}`,
              name: "inline-score",
              timestamp: new Date().toISOString(),
              dataType: "numeric",
              value: 1,
              source: "sdk"
            }
          }
        : {
            type: "trace-upsert",
            body: { id: `trace_${ulid()}`, timestamp: new Date().toISOString(), name: "capability-test" }
          }
    ]
  };
}

function otlpBody() {
  return {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: "0af7651916cd43dd8448eb211c80319c",
                spanId: "b7ad6b7169203331",
                name: "capability-test",
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000001000000000"
              }
            ]
          }
        ]
      }
    ]
  };
}

function langfuseBody() {
  return {
    batch: [
      {
        id: `event_${ulid()}`,
        timestamp: new Date().toISOString(),
        type: "trace-create",
        body: { id: `trace_${ulid()}`, name: "compat" }
      }
    ]
  };
}

type RouteCase = {
  name: string;
  request: (token: string) => Response | Promise<Response>;
  allowedStatus: number;
};

const ingestRoutes: RouteCase[] = [
  {
    name: "native ingest",
    allowedStatus: 202,
    request: (token) =>
      app.request("/api/v1/ingest", {
        method: "POST",
        headers: bearer(token, "application/json"),
        body: JSON.stringify(nativeBatch())
      })
  },
  {
    name: "OTLP ingest",
    allowedStatus: 200,
    request: (token) =>
      app.request("/v1/otel/traces", {
        method: "POST",
        headers: bearer(token, "application/json"),
        body: JSON.stringify(otlpBody())
      })
  },
  {
    name: "LangFuse ingest",
    allowedStatus: 207,
    request: (token) =>
      app.request("/api/public/ingestion", {
        method: "POST",
        headers: bearer(token, "application/json"),
        body: JSON.stringify(langfuseBody())
      })
  }
];

const mediaRoute: RouteCase = {
  name: "media upload",
  allowedStatus: 201,
  request: (token) =>
    app.request("/api/v1/media", {
      method: "POST",
      headers: bearer(token, "image/png"),
      body: new Uint8Array([137, 80, 78, 71])
    })
};

const traceRoutes: RouteCase[] = [
  {
    name: "native evaluator context",
    allowedStatus: 200,
    request: (token) => app.request("/api/v1/evaluator/context", { headers: bearer(token) })
  },
  {
    name: "native evaluator trace feed",
    allowedStatus: 200,
    request: (token) => app.request("/api/v1/evaluator/traces?limit=1", { headers: bearer(token) })
  },
  {
    name: "trace list",
    allowedStatus: 200,
    request: (token) => app.request("/api/public/traces?limit=1", { headers: bearer(token) })
  },
  {
    name: "trace detail",
    allowedStatus: 404,
    request: (token) => app.request(`/api/public/traces/trace_${ulid()}`, { headers: bearer(token) })
  }
];

const scoreRoute: RouteCase = {
  name: "standalone score write",
  allowedStatus: 200,
  request: (token) =>
    app.request("/api/public/scores", {
      method: "POST",
      headers: bearer(token, "application/json"),
      body: JSON.stringify({ traceId: `trace_${ulid()}`, name: "verdict", value: 1 })
    })
};

const evaluatorScoreRoute: RouteCase = {
  name: "native evaluator score write",
  allowedStatus: 200,
  request: (token) =>
    app.request("/api/v1/evaluator/scores", {
      method: "POST",
      headers: bearer(token, "application/json"),
      body: JSON.stringify({
        id: `score_${ulid()}`,
        traceId: `trace_${ulid()}`,
        name: "coeval_assessment/support-quality",
        value: 1,
        assessmentLabel: "pass",
        evaluator: {
          provider: "coeval",
          versionId: "skillv_1",
          criterionKey: "support-quality"
        }
      })
    })
};

describe("machine route capability matrix", () => {
  for (const route of [...ingestRoutes, mediaRoute]) {
    it(`allows Ingest, but denies Integration: ${route.name}`, async () => {
      expect((await route.request(ingestToken)).status).toBe(route.allowedStatus);
      expect((await route.request(integrationToken)).status).toBe(403);
    });
  }

  for (const route of [...traceRoutes, scoreRoute, evaluatorScoreRoute]) {
    it(`allows Integration, but denies Ingest: ${route.name}`, async () => {
      expect((await route.request(integrationToken)).status).toBe(route.allowedStatus);
      expect((await route.request(ingestToken)).status).toBe(403);
    });
  }

  it("keeps inline SDK score events inside the ingest capability while denying the standalone score route", async () => {
    const inline = await app.request("/api/v1/ingest", {
      method: "POST",
      headers: bearer(ingestToken, "application/json"),
      body: JSON.stringify(nativeBatch(true))
    });
    expect(inline.status).toBe(202);
    expect((await scoreRoute.request(ingestToken)).status).toBe(403);
  });

  it("enforces capabilities under LangFuse Basic auth too", async () => {
    const basic = (token: string) => `Basic ${Buffer.from(`ironside:${token}`).toString("base64")}`;
    expect(
      (
        await app.request("/api/public/traces?limit=1", {
          headers: { authorization: basic(integrationToken) }
        })
      ).status
    ).toBe(200);
    expect(
      (
        await app.request("/api/public/ingestion", {
          method: "POST",
          headers: { authorization: basic(integrationToken), "content-type": "application/json" },
          body: JSON.stringify(langfuseBody())
        })
      ).status
    ).toBe(403);
  });

  it("cannot use any machine credential on owner management", async () => {
    const paths = [
      "/api/auth/session",
      "/api/v1/projects",
      `/api/v1/projects/${projectId}/credentials`,
      `/api/v1/projects/${projectId}/exports`,
      `/api/v1/projects/${projectId}/otlp-forwards`,
      `/api/v1/projects/${projectId}/webhooks`,
      `/api/v1/projects/${projectId}/import-sources`,
      `/api/v1/projects/${projectId}/ingest-failures`
    ];
    for (const token of [ingestToken, integrationToken]) {
      for (const path of paths) {
        const res = await app.request(path, { headers: bearer(token) });
        expect(res.status, `${token.slice(0, 12)} on ${path}`).toBe(401);
      }
    }
  });
});
