// Heavy ingest load driver: sustained multi-event batches against
// POST /api/v1/ingest, measuring ACK latency percentiles, error rate, and
// exact event counts (for the post-run ClickHouse integrity check).
//
// Usage: IRONSIDE_LOAD_TEST_KEY=... node load/heavy-burst.mjs [rps] [seconds] [eventsPerBatch]
// Defaults: 200 rps, 30s, 20 events/batch (1 trace + 19 observations)
// = 4,000 events/sec, 120k events total at defaults.

const HOST = process.env.IRONSIDE_HOST ?? "http://localhost:8788";
const KEY = process.env.IRONSIDE_LOAD_TEST_KEY;
if (!KEY) throw new Error("IRONSIDE_LOAD_TEST_KEY required");

const rps = Number(process.argv[2] ?? 200);
const seconds = Number(process.argv[3] ?? 30);
const eventsPerBatch = Number(process.argv[4] ?? 20);
const runId = `load_${Date.now()}`;

let sent = 0;
let acked = 0;
let failed = 0;
let tracesSent = 0;
let observationsSent = 0;
const latencies = [];

function buildBatch(n) {
  const traceId = `trace_${runId}_${n}`;
  const now = new Date().toISOString();
  const events = [
    {
      type: "trace-upsert",
      body: {
        id: traceId,
        timestamp: now,
        name: "load-test",
        userId: `user_${n % 100}`,
        tags: [runId],
        metadata: { run: runId },
        input: { question: `q-${n}`, padding: "x".repeat(200) }
      }
    }
  ];
  tracesSent += 1;
  for (let i = 1; i < eventsPerBatch; i++) {
    events.push({
      type: "observation-upsert",
      body: {
        id: `obs_${runId}_${n}_${i}`,
        traceId,
        type: i % 3 === 0 ? "generation" : "span",
        name: `step-${i}`,
        startTime: now,
        endTime: now,
        ...(i % 3 === 0 && {
          model: "gpt-4o",
          usageDetails: { input_tokens: 100, output_tokens: 50 },
          modelParameters: { temperature: 0.7 }
        }),
        input: { step: i },
        output: { result: `r-${i}`, padding: "y".repeat(200) },
        metadata: { run: runId }
      }
    });
    observationsSent += 1;
  }
  return { events };
}

async function fire(n) {
  const body = JSON.stringify(buildBatch(n));
  const start = performance.now();
  try {
    const res = await fetch(`${HOST}/api/v1/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body
    });
    latencies.push(performance.now() - start);
    if (res.status === 202) acked += 1;
    else {
      failed += 1;
      if (failed <= 3) console.error(`non-202: ${res.status} ${await res.text()}`);
    }
  } catch (error) {
    latencies.push(performance.now() - start);
    failed += 1;
    if (failed <= 3) console.error("request error:", error.message);
  }
}

const inflight = new Set();
const intervalMs = 1000 / rps;
const endAt = Date.now() + seconds * 1000;

console.log(`firing ${rps} req/s for ${seconds}s, ${eventsPerBatch} events/batch (${rps * eventsPerBatch} events/s target), run=${runId}`);

while (Date.now() < endAt) {
  const p = fire(sent++);
  inflight.add(p);
  p.finally(() => inflight.delete(p));
  await new Promise((r) => setTimeout(r, intervalMs));
}
await Promise.all([...inflight]);

latencies.sort((a, b) => a - b);
const pct = (q) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))].toFixed(1);
console.log(JSON.stringify({
  runId,
  requestsSent: sent,
  acked,
  failed,
  tracesSent,
  observationsSent,
  totalEvents: tracesSent + observationsSent,
  latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: latencies[latencies.length - 1].toFixed(1) }
}, null, 2));
