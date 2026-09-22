import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ObservationNode, Project, TraceTreeResponse } from "@ironside/shared/browser";
import { describe, expect, it } from "vitest";
import { ActiveProjectProvider } from "../src/lib/projects.js";
import { TraceRecordView } from "../src/screens/trace.js";

function observation(id: string, children: ObservationNode[] = []): ObservationNode {
  return {
    id,
    parentObservationId: null,
    type: "span",
    name: id,
    startTime: "2026-08-25T00:00:00.000Z",
    endTime: "2026-08-25T00:00:01.000Z",
    level: "DEFAULT",
    statusMessage: null,
    model: null,
    modelParameters: {},
    input: null,
    output: null,
    usageDetails: {},
    costDetails: {},
    completionStartTime: null,
    metadata: {},
    children
  };
}

const project: Project = {
  id: "project_test",
  organizationId: "org_test",
  name: "Test",
  createdAt: "2026-08-25T00:00:00.000Z",
  rateLimitPerMinute: null,
  retentionDays: null,
  traceQuietPeriodSeconds: null
};

function trace(): TraceTreeResponse {
  return {
    id: "trace_test",
    timestamp: "2026-08-25T00:00:00.000Z",
    name: "Trace",
    userId: null,
    sessionId: null,
    environment: null,
    release: null,
    version: null,
    tags: [],
    metadata: {},
    input: null,
    output: null,
    observations: [observation("parent", [observation("child")]), observation("sibling")]
  };
}

function render(coevalUrl?: string | null, record: TraceTreeResponse = trace()): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null,
      createElement(ActiveProjectProvider, { project, projects: [project] },
        createElement(TraceRecordView, { trace: record, coevalUrl })
      )
    )
  );
}

describe("TraceRecordView", () => {
  it("renders a labelled single-select tree with one roving tab stop", () => {
    const html = render();

    expect(html).toContain('role="tree"');
    expect(html.match(/role="treeitem"/g)).toHaveLength(3);
    expect(html.match(/role="treeitem"[^>]*tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-level="2"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-selected="false"');
    expect(html).toContain("hover:bg-card-2");
    expect(html).toContain("trace-tree-row");
  });

  it("hides the Coeval link unless the operator configured a Coeval URL", () => {
    expect(render()).not.toContain("Open in Coeval");
    expect(render(null)).not.toContain("Open in Coeval");
  });

  it("links the trace to Coeval using the evaluator project and trace identity", () => {
    const html = render("https://coeval.example.com/app", { ...trace(), id: "trace/with space" });
    expect(html).toContain("Open in Coeval");
    expect(html).toContain(
      'href="https://coeval.example.com/app/links/trace?source=ironside&amp;project=project_test&amp;trace=trace%2Fwith+space"'
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
