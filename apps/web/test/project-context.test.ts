import { describe, expect, it } from "vitest";
import type { Project } from "@ironside/shared/browser";
import { selectInitialProject } from "../src/lib/project-storage.js";
import { filtersFromSearchParams, searchParamsFromFilters } from "../src/screens/traces.js";
import {
  environmentOptions,
  pathWithEnvironment,
  setEnvironmentSearchParam
} from "../src/lib/environment-filter.js";

function project(id: string): Project {
  return {
    id,
    organizationId: "org_test",
    name: id,
    createdAt: new Date(0).toISOString(),
    rateLimitPerMinute: null,
    retentionDays: null,
    traceQuietPeriodSeconds: null
  };
}

describe("project URL context", () => {
  it("uses a stored project only after validating it against the owner project list", () => {
    const projects = [project("proj_first"), project("proj_second")];
    expect(selectInitialProject(projects, "proj_second")?.id).toBe("proj_second");
    expect(selectInitialProject(projects, "proj_foreign")?.id).toBe("proj_first");
    expect(selectInitialProject([], "proj_second")).toBeNull();
  });

  it("round-trips shareable trace filters and repeated tags", () => {
    const search = searchParamsFromFilters({
      userId: " user_1 ",
      sessionId: "session_2",
      tags: "prod, checkout",
      environment: "production"
    });
    expect(search.toString()).toBe("userId=user_1&sessionId=session_2&environment=production&tags=prod&tags=checkout");
    expect(filtersFromSearchParams(search)).toEqual({
      userId: "user_1",
      sessionId: "session_2",
      tags: "prod, checkout",
      environment: "production"
    });
  });

  it("changes only the global environment parameter and preserves local filters", () => {
    const current = new URLSearchParams("userId=user_1&tags=checkout&tags=prod");
    const selected = setEnvironmentSearchParam(current, "staging");
    expect(selected.toString()).toBe("userId=user_1&tags=checkout&tags=prod&environment=staging");
    expect(setEnvironmentSearchParam(selected, null).toString()).toBe(
      "userId=user_1&tags=checkout&tags=prod"
    );
    expect(pathWithEnvironment("/projects/proj_1/settings", selected)).toBe(
      "/projects/proj_1/settings?environment=staging"
    );
  });

  it("keeps hidden and overflow-only deep links selected without exposing other hidden values", () => {
    const environments = [
      { name: "production", firstSeenAt: "a", lastSeenAt: "b", hidden: false },
      { name: "staging", firstSeenAt: "a", lastSeenAt: "b", hidden: true }
    ];
    expect(environmentOptions(environments, "staging")).toEqual([
      { name: "staging", suffix: "hidden" },
      { name: "production", suffix: null }
    ]);
    expect(environmentOptions(environments, "preview-42")[0]).toEqual({
      name: "preview-42",
      suffix: "unlisted"
    });
  });
});
