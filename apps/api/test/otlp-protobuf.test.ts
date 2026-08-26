import { gzipSync } from "node:zlib";
import { serve, type ServerType } from "@hono/node-server";
import {
  createClickHouseClient,
  runMigrations as runChMigrations
} from "@ironside/clickhouse";
import { runMigrations as runPgMigrations } from "@ironside/db";
import { createIngestQueue } from "@ironside/queue";
import { mapOtlpTraceRequest } from "@ironside/mappers";
import { otlpExportTraceServiceRequestSchema, type IngestBatch } from "@ironside/shared";
import { createObjectStorage } from "@ironside/storage";
import { context, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Redis } from "ioredis";
import { Pool } from "pg";
import protobuf from "protobufjs";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestMachineCredential } from "./helpers/machine-credential.js";

// OTLP/HTTP+protobuf ingest (M9-06). Three layers of proof:
// 1. Parity: the same export sent as protobuf and as JSON produces an
//    identical stored raw envelope (same body, same idempotency key) —
//    the protobuf path is a decode step, not a second pipeline.
// 2. Conformance: the REAL OTel JS SDK protobuf exporter
//    (@opentelemetry/exporter-trace-otlp-proto — what actual users run)
//    exports through a real HTTP server into the route, and the worker's
//    mapper reconstructs the correct parent/child trace tree from what
//    was stored.
// 3. Encoding/transport edges: gzip bodies (the OTel Collector's otlphttp
//    exporter compresses by default), undecodable protobuf, unsupported
//    content-encodings, and the spec-required protobuf success response.

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const clickhouse = createClickHouseClient(config.clickhouse);
const storage = createObjectStorage(config.storage);
const queue = createIngestQueue(config.redisUrl);

// Wrap storage so tests can see the exact raw envelope each request
// persisted (the route generates batch ids internally, so the object key
// isn't otherwise knowable from outside).
const storedBatches: IngestBatch[] = [];
const capturingStorage: typeof storage = {
  ...storage,
  putJson: async (key: string, value: unknown) => {
    if (key.startsWith("raw/")) storedBatches.push(value as IngestBatch);
    return storage.putJson(key, value);
  }
};

const app = createApp({
  pgPool: pool,
  clickhouse,
  redis,
  storage: capturingStorage,
  queue,
  webOrigins: ["http://localhost:5174"],
  defaultRateLimitPerMinute: 10000
});

let apiKey: string;
let projectId: string;

beforeAll(async () => {
  await runPgMigrations(pool);
  await runChMigrations(clickhouse);
  await storage.ensureBucket();
  const orgId = `org_${ulid()}`;
  projectId = `proj_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "otlp-proto-test-org"
  ]);
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, "otlp-proto-test"]
  );
  apiKey = (await createTestMachineCredential(pool, projectId, "otlp-proto-test", "ingest")).token;
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'otlp-proto-test-org'");
  await queue.close();
  await pool.end();
  redis.disconnect();
  await clickhouse.close();
  storage.close();
});

// The same fixture in both encodings. JSON uses the OTLP/JSON mapping
// (hex ids, string int64s); the protobuf encoder needs raw bytes for ids.
const TRACE_ID_HEX = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID_HEX = "b7ad6b7169203331";

function jsonExport() {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "proto-parity" } }]
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE_ID_HEX,
                spanId: SPAN_ID_HEX,
                name: "chat gpt-4o",
                kind: 3,
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000001000000000",
                attributes: [
                  { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                  { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: "50" } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: "75" } },
                  { key: "gen_ai.request.temperature", value: { doubleValue: 0.7 } }
                ],
                status: { code: 1 },
                events: [
                  { timeUnixNano: "1700000000500000000", name: "first-token" }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

// Encode the fixture with protobufjs against the SAME vendored .proto
// files the route decodes with — deliberately exercising the full
// encode->decode->JSON-shape conversion, not just an identity function.
function protobufExport(): Buffer {
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) =>
    target.startsWith("/") ? target : new URL(`../proto/${target}`, import.meta.url).pathname;
  root.loadSync(
    new URL("../proto/opentelemetry/proto/collector/trace/v1/trace_service.proto", import.meta.url).pathname
  );
  const requestType = root.lookupType(
    "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest"
  );
  const json = jsonExport();
  const span = json.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  const message = requestType.fromObject({
    resourceSpans: [
      {
        resource: json.resourceSpans[0]!.resource,
        scopeSpans: [
          {
            spans: [
              {
                ...span,
                traceId: Buffer.from(TRACE_ID_HEX, "hex"),
                spanId: Buffer.from(SPAN_ID_HEX, "hex")
              }
            ]
          }
        ]
      }
    ]
  });
  const encoded = Buffer.from(requestType.encode(message).finish());
  expect(requestType.verify(requestType.decode(encoded))).toBeNull();
  return encoded;
}

async function post(body: string | Buffer, headers: Record<string, string>) {
  return app.request("/v1/otel/traces", {
    method: "POST",
    body,
    headers: { authorization: `Bearer ${apiKey}`, ...headers }
  });
}

describe("POST /v1/otel/traces (protobuf)", () => {
  it("accepts a protobuf export and answers with a protobuf ExportTraceServiceResponse", async () => {
    const res = await post(protobufExport(), { "content-type": "application/x-protobuf" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-protobuf");
    // Empty message = fully accepted (all fields default) — zero bytes.
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("stores the SAME raw envelope for protobuf and JSON encodings of one export (parity + shared idempotency key)", async () => {
    storedBatches.length = 0;

    const protoRes = await post(protobufExport(), { "content-type": "application/x-protobuf" });
    const jsonRes = await post(JSON.stringify(jsonExport()), { "content-type": "application/json" });
    expect(protoRes.status).toBe(200);
    expect(jsonRes.status).toBe(200);
    expect(storedBatches).toHaveLength(2);

    const [protoEvent, jsonEvent] = [storedBatches[0]!.events[0]!, storedBatches[1]!.events[0]!];
    expect(protoEvent.body).toEqual(jsonEvent.body);
    expect(protoEvent.idempotencyKey).toBe(jsonEvent.idempotencyKey);
  });

  it("accepts gzip content-encoding for both encodings", async () => {
    const protoRes = await post(gzipSync(protobufExport()), {
      "content-type": "application/x-protobuf",
      "content-encoding": "gzip"
    });
    expect(protoRes.status).toBe(200);

    const jsonRes = await post(gzipSync(Buffer.from(JSON.stringify(jsonExport()))), {
      "content-type": "application/json",
      "content-encoding": "gzip"
    });
    expect(jsonRes.status).toBe(200);
  });

  it("rejects a gzip-declared body that is not gzip with 400", async () => {
    const res = await post(protobufExport(), {
      "content-type": "application/x-protobuf",
      "content-encoding": "gzip"
    });
    expect(res.status).toBe(400);
  });

  it("rejects a gzip bomb with 413 instead of decompressing it into memory", async () => {
    // 64MB of zeros gzips to ~64KB — sails through the 10MB wire-size
    // bodyLimit, then would expand 1000:1 in one synchronous allocation
    // without the maxOutputLength cap (review finding, PR #38).
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const res = await post(bomb, {
      "content-type": "application/x-protobuf",
      "content-encoding": "gzip"
    });
    expect(res.status).toBe(413);
  });

  it("a protobuf span with start_time_unix_nano unset (proto3 zero-default) is rejected 400, matching the schema's required field", async () => {
    // toObject omits proto3 zero-defaults, so an absent/zero start time
    // decodes to a missing startTimeUnixNano and Zod rejects it — pinned
    // deliberately: a compliant exporter always sets a real timestamp
    // (the proto comment calls the field "semantically required"), and a
    // 1970-epoch start time is garbage we'd rather 400 than store.
    const root = new protobuf.Root();
    root.resolvePath = (_origin, target) =>
      target.startsWith("/") ? target : new URL(`../proto/${target}`, import.meta.url).pathname;
    root.loadSync(
      new URL("../proto/opentelemetry/proto/collector/trace/v1/trace_service.proto", import.meta.url).pathname
    );
    const requestType = root.lookupType(
      "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest"
    );
    const message = requestType.fromObject({
      resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: Buffer.from(TRACE_ID_HEX, "hex"),
        spanId: Buffer.from(SPAN_ID_HEX, "hex"),
        name: "no-start-time"
      }] }] }]
    });
    const res = await post(Buffer.from(requestType.encode(message).finish()), {
      "content-type": "application/x-protobuf"
    });
    expect(res.status).toBe(400);
  });

  it("rejects unsupported content-encodings with 415", async () => {
    const res = await post(protobufExport(), {
      "content-type": "application/x-protobuf",
      "content-encoding": "br"
    });
    expect(res.status).toBe(415);
  });

  it("rejects undecodable protobuf with 400, not a crash", async () => {
    const res = await post(Buffer.from([0xff, 0xff, 0xff, 0xff]), {
      "content-type": "application/x-protobuf"
    });
    expect(res.status).toBe(400);
  });

  it("the real OTel JS SDK protobuf exporter exports through the route and the mapper rebuilds the trace tree", async () => {
    const server: ServerType = serve({ fetch: app.fetch, port: 0 });
    const port = (server.address() as { port: number }).port;
    try {
      storedBatches.length = 0;

      const exporter = new OTLPTraceExporter({
        url: `http://127.0.0.1:${port}/v1/otel/traces`,
        headers: { authorization: `Bearer ${apiKey}` }
      });
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)]
      });
      const tracer = provider.getTracer("conformance");

      const parent = tracer.startSpan("handle-request");
      const child = tracer.startSpan(
        "chat gpt-4o",
        {
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": "gpt-4o",
            "gen_ai.usage.input_tokens": 50,
            "gen_ai.usage.output_tokens": 75
          }
        },
        trace.setSpan(context.active(), parent)
      );
      const expectedTraceId = parent.spanContext().traceId;
      const expectedParentSpanId = parent.spanContext().spanId;
      child.end();
      parent.end();
      // shutdown flushes SimpleSpanProcessor's pending exports.
      await provider.shutdown();

      // SimpleSpanProcessor exports each span as its own request.
      expect(storedBatches.length).toBeGreaterThanOrEqual(1);
      const bodies = storedBatches.map((b) =>
        otlpExportTraceServiceRequestSchema.parse(b.events[0]!.body)
      );
      const mapped = bodies.map((body) => mapOtlpTraceRequest(projectId, body));
      const observations = mapped.flatMap((m) => m.observations);
      const traces = mapped.flatMap((m) => m.traces);

      expect(traces.some((t) => t.id === expectedTraceId)).toBe(true);
      const generation = observations.find((o) => o.name === "chat gpt-4o");
      expect(generation).toBeDefined();
      expect(generation!.traceId).toBe(expectedTraceId);
      expect(generation!.parentObservationId).toBe(expectedParentSpanId);
      expect(generation!.model).toBe("gpt-4o");
      expect(generation!.usageDetails).toEqual({ input_tokens: 50, output_tokens: 75 });
    } finally {
      server.close();
    }
  });
});
