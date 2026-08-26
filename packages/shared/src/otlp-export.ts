import { createHash } from "node:crypto";

// Derives OTLP-valid hex trace/span IDs from Ironside's own arbitrary
// string ids (ULIDs, imported UUIDs, etc). Per the OTel proto spec
// (opentelemetry-proto trace.proto): trace_id MUST be exactly 16 raw bytes
// (32 hex chars) and span_id exactly 8 raw bytes (16 hex chars); an
// all-zero or wrong-length ID is explicitly invalid. Since Ironside's ids
// don't natively fit that shape, this hashes the source id deterministically
// so the same Ironside id always maps to the same OTLP id (stable across
// repeated forwarding runs, so downstream systems see one consistent trace,
// not a new one every time the same trace is re-forwarded).
//
// SHA-256 is used purely as a well-distributed deterministic byte source,
// not for any security property — collision risk is astronomically low at
// realistic trace volumes and is an accepted tradeoff, not a correctness
// guarantee this code depends on.

export function toOtlpTraceId(ironsideTraceId: string): string {
  return createHash("sha256").update(`trace:${ironsideTraceId}`).digest("hex").slice(0, 32);
}

export function toOtlpSpanId(ironsideObservationId: string): string {
  return createHash("sha256").update(`span:${ironsideObservationId}`).digest("hex").slice(0, 16);
}
