import {
  listProjectEnvironments,
  setProjectEnvironmentHidden,
  type ProjectEnvironmentRecord
} from "@ironside/db";
import {
  MAX_OBSERVED_ENVIRONMENTS_PER_PROJECT,
  updateProjectEnvironmentRequestSchema,
  type ListProjectEnvironmentsResponse,
  type ProjectEnvironment
} from "@ironside/shared";
import { Hono } from "hono";
import type { Pool } from "pg";
import type { OwnerProjectEnv } from "../middleware/owner-session.js";

export interface EnvironmentsDeps {
  pool: Pool;
}

function toResponse(environment: ProjectEnvironmentRecord): ProjectEnvironment {
  return {
    name: environment.name,
    firstSeenAt: environment.firstSeenAt.toISOString(),
    lastSeenAt: environment.lastSeenAt.toISOString(),
    hidden: environment.hidden
  };
}

/** Owner-only discovery/preferences. This route never gates trace queries. */
export function environmentsRoutes(deps: EnvironmentsDeps): Hono<OwnerProjectEnv> {
  const app = new Hono<OwnerProjectEnv>();

  app.get("/environments", async (c) => {
    const registry = await listProjectEnvironments(deps.pool, c.get("projectId"));
    const response: ListProjectEnvironmentsResponse = {
      environments: registry.environments.map(toResponse),
      limit: MAX_OBSERVED_ENVIRONMENTS_PER_PROJECT,
      overflowed: registry.overflowed,
      overflowLastSeenAt: registry.lastOverflowAt?.toISOString() ?? null,
      lastRebuiltAt: registry.lastRebuiltAt?.toISOString() ?? null
    };
    return c.json(response, 200);
  });

  app.patch("/environments/visibility", async (c) => {
    const parsed = updateProjectEnvironmentRequestSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const updated = await setProjectEnvironmentHidden(
      deps.pool,
      c.get("projectId"),
      parsed.data.environment,
      parsed.data.hidden
    );
    if (!updated) return c.json({ error: "environment not found" }, 404);
    return c.json(toResponse(updated), 200);
  });

  return app;
}
