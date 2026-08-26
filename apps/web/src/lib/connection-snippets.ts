export interface ConnectionSnippet {
  id: "native" | "otlp" | "langfuse" | "integration";
  preset: "ingest" | "integration";
  title: string;
  description: string;
  code: string;
}

function normalizeHost(host: string): string {
  return host.replace(/\/+$/, "");
}

export function buildNativeIngestCurl(host: string, payload: string): string {
  return `curl -X POST '${normalizeHost(host)}/api/v1/ingest' -H "Authorization: Bearer \${IRONSIDE_API_KEY}" -H 'Content-Type: application/json' -d '${payload}'`;
}

/** Exact copy/paste examples for the machine-only data-plane contracts. */
export function buildConnectionSnippets(host: string): ConnectionSnippet[] {
  const base = normalizeHost(host);
  return [
    {
      id: "native",
      preset: "ingest",
      title: "Node.js SDK",
      description: "Native traces, observations, scores, and media.",
      code: `import { init } from "ironside";

const ironside = init({
  host: ${JSON.stringify(base)},
  apiKey: process.env.IRONSIDE_API_KEY!
});`
    },
    {
      id: "otlp",
      preset: "ingest",
      title: "OpenTelemetry",
      description: "Portable OTLP/HTTP trace ingestion.",
      code: `export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${base}/v1/otel/traces
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="authorization=Bearer%20\${IRONSIDE_API_KEY}"`
    },
    {
      id: "langfuse",
      preset: "ingest",
      title: "LangFuse v3 SDK",
      description: "Legacy LangFuse ingestion compatibility.",
      code: `export LANGFUSE_BASEURL=${base}
export LANGFUSE_PUBLIC_KEY=ironside
export LANGFUSE_SECRET_KEY="\${IRONSIDE_API_KEY}"`
    },
    {
      id: "integration",
      preset: "integration",
      title: "Evaluator integration",
      description: "Read settled traces and submit scores through the LangFuse-compatible API.",
      code: `curl --fail-with-body \\
  --header "Authorization: Bearer \${IRONSIDE_API_KEY}" \\
  "${base}/api/public/traces?limit=20"

curl --fail-with-body --request POST \\
  --header "Authorization: Bearer \${IRONSIDE_API_KEY}" \\
  --header "Content-Type: application/json" \\
  --data '{"traceId":"<trace-id>","name":"quality","value":1}' \\
  "${base}/api/public/scores"`
    }
  ];
}
