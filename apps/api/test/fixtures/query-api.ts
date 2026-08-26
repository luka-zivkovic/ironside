import type { Observation, Trace } from "@ironside/shared";
import { ulid } from "ulid";

/**
 * One deterministic dataset shared by the M2 contract tests
 * (list/tree/aggregates), so results can be cross-checked against each
 * other (e.g. a trace's aggregate token total must equal the sum of its
 * own observations' usage) rather than each endpoint only being checked
 * in isolation against ad-hoc per-test data.
 */
export interface QueryApiFixture {
  marker: string;
  traces: Trace[];
  observations: Observation[];
  /** trace with 2 nested observations, known usage/cost, a 1500ms span */
  richTraceId: string;
  /** trace with zero observations — exercises "no latency sample" paths */
  bareTraceId: string;
}

export function buildQueryApiFixture(projectId: string): QueryApiFixture {
  const marker = `contract_${ulid()}`;
  const richTraceId = `trace_${marker}_rich`;
  const bareTraceId = `trace_${marker}_bare`;
  const rootObsId = `obs_${marker}_root`;
  const childObsId = `obs_${marker}_child`;
  // Keep this shared ClickHouse fixture in the current retention window.
  // Retention tests run in parallel and deliberately drop old partitions.
  const baseMs = Date.now() - 5_000;
  const at = (offsetMs: number) => new Date(baseMs + offsetMs).toISOString();

  const traces: Trace[] = [
    {
      id: richTraceId,
      projectId,
      timestamp: at(0),
      name: "checkout",
      userId: "user_contract_1",
      sessionId: "sess_contract_1",
      tags: [marker, "prod"],
      metadata: { plan: "enterprise" },
      input: { cart: ["sku_1"] },
      output: { total: 42 }
    },
    {
      id: bareTraceId,
      projectId,
      timestamp: at(3_000),
      name: "healthcheck",
      tags: [marker],
      metadata: {}
    }
  ];

  const observations: Observation[] = [
    {
      id: rootObsId,
      traceId: richTraceId,
      projectId,
      type: "span",
      name: "handle-request",
      startTime: at(0),
      endTime: at(1_500),
      level: "default",
      metadata: {}
    },
    {
      id: childObsId,
      traceId: richTraceId,
      projectId,
      parentObservationId: rootObsId,
      type: "generation",
      name: "llm-call",
      model: "claude-contract-test",
      startTime: at(200),
      endTime: at(1_400),
      usageDetails: { input_tokens: 120, output_tokens: 340 },
      costDetails: { total: 2.5 },
      level: "default",
      metadata: {}
    }
  ];

  return { marker, traces, observations, richTraceId, bareTraceId };
}
