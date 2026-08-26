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

describe("TraceRecordView", () => {
  it("renders a labelled single-select tree with one roving tab stop", () => {
    const project: Project = {
      id: "project_test",
      organizationId: "org_test",
      name: "Test",
      createdAt: "2026-08-25T00:00:00.000Z",
      rateLimitPerMinute: null,
      retentionDays: null,
      traceQuietPeriodSeconds: null
    };
    const trace: TraceTreeResponse = {
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

    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null,
        createElement(ActiveProjectProvider, { project, projects: [project] },
          createElement(TraceRecordView, { trace })
        )
      )
    );

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
});
