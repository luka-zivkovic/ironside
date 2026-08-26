import { isAbsolute, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

// OTLP/HTTP+protobuf codec for POST /v1/otel/traces. Decodes a binary
// ExportTraceServiceRequest into the SAME shape the OTLP/JSON path
// receives (camelCase keys, int64s as decimal strings, trace/span ids as
// hex, other bytes as base64 — the standard protobuf JSON mapping with
// OTLP's id-fields-are-hex override), so everything downstream of the
// content-type branch (Zod schema, raw envelope, worker mapper) is one
// shared code path and the two encodings are idempotency-equivalent:
// the same export sent as protobuf and as JSON hashes to the same key.
//
// The .proto files are vendored (apps/api/proto/, Apache-2.0, pinned to
// opentelemetry-proto v1.10.0 — see proto/README.md) rather than pulled
// from @opentelemetry/otlp-transformer, which is documented as internal
// to the OTel JS SDK with no semver guarantees (same reasoning as the
// hand-written Zod schema in packages/shared/src/otlp.ts).

// __dirname is dist/src at runtime; proto files are copied to dist/proto
// by the build script (data, not TS — tsc won't emit them). In dev
// (tsx src/), the same ../proto hop lands on the source directory.
const PROTO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "proto");

const root = new protobuf.Root();
root.resolvePath = (_origin, target) =>
  isAbsolute(target) ? target : join(PROTO_DIR, target);
root.loadSync(
  join(PROTO_DIR, "opentelemetry/proto/collector/trace/v1/trace_service.proto")
);

const exportTraceServiceRequest = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest"
);
const exportTraceServiceResponse = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse"
);

// OTLP JSON mapping: trace_id/span_id/parent_span_id are hex strings;
// every other bytes field is standard-protobuf-JSON base64.
const HEX_BYTE_KEYS = new Set(["traceId", "spanId", "parentSpanId"]);

function bytesToJson(value: unknown, keyHint: string): unknown {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString(HEX_BYTE_KEYS.has(keyHint) ? "hex" : "base64");
  }
  if (Array.isArray(value)) {
    return value.map((item) => bytesToJson(item, keyHint));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = bytesToJson(child, key);
    }
    return out;
  }
  return value;
}

/**
 * Decodes a binary ExportTraceServiceRequest into the OTLP/JSON object
 * shape. Throws on malformed protobuf (the caller maps that to a 400).
 * Returns `unknown` deliberately — the result must still pass the same
 * Zod validation as a JSON body; decoding successfully proves nothing
 * about semantic validity (protobuf is lenient enough that many garbage
 * byte strings "decode").
 */
export function decodeExportTraceServiceRequest(body: Uint8Array): unknown {
  const message = exportTraceServiceRequest.decode(body);
  // longs: String — int64 timestamps/intValues exceed Number.MAX_SAFE_INTEGER
  // and the JSON mapping stringifies them anyway. Enums stay numbers and
  // absent fields stay absent (protobufjs defaults), both matching what
  // real OTLP/JSON exporters send.
  const obj = exportTraceServiceRequest.toObject(message, { longs: String });
  return bytesToJson(obj, "");
}

/**
 * A fully-successful ExportTraceServiceResponse (no partial_success set),
 * serialized. Encodes to zero bytes — an empty message is the protobuf
 * spec's representation of "all fields default".
 */
export function encodeEmptyExportTraceServiceResponse(): Uint8Array {
  return exportTraceServiceResponse.encode(exportTraceServiceResponse.create({})).finish();
}
