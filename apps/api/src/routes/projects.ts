import { listProjectsForOrganization, setProjectQuotas, type Project } from "@ironside/db";
import {
  createProjectRequestSchema,
  updateProjectQuotasRequestSchema,
  type CreatedProjectWithCredential,
  type ListProjectsResponse,
  type Project as ProjectResponse
} from "@ironside/shared";
import { Hono } from "hono";
import type { Pool } from "pg";
import type { OwnerProjectEnv } from "../middleware/owner-session.js";
import type { AuthEnv } from "../middleware/auth.js";
import { createProjectWithBootstrapCredential } from "../lib/project-bootstrap.js";

export interface ProjectsDeps {
  pool: Pool;
}

function toResponse(project: Project): ProjectResponse {
  return {
    id: project.id,
    organizationId: project.organizationId,
    name: project.name,
    createdAt: project.createdAt.toISOString(),
    rateLimitPerMinute: project.rateLimitPerMinute,
    retentionDays: project.retentionDays,
    traceQuietPeriodSeconds: project.traceQuietPeriodSeconds
  };
}

/** Organization-level project registry for the authenticated owner. */
export function projectsRoutes(deps: ProjectsDeps): Hono<OwnerProjectEnv> {
  const app = new Hono<OwnerProjectEnv>();

  app.get("/", async (c) => {
    const projects = await listProjectsForOrganization(deps.pool, c.get("ownerSession").organizationId);
    const response: ListProjectsResponse = { projects: projects.map(toResponse) };
    return c.json(response, 200);
  });

  app.post("/", async (c) => {
    const parsed = createProjectRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }

    const created = await createProjectWithBootstrapCredential(deps.pool, {
      organizationId: c.get("ownerSession").organizationId,
      name: parsed.data.name,
      principalId: c.get("ownerSession").principalId,
      username: c.get("ownerSession").username
    });
    const response: CreatedProjectWithCredential = {
      project: toResponse(created.project),
      initialCredential: {
        ...created.initialCredential,
        createdAt: created.initialCredential.createdAt.toISOString(),
        expiresAt: created.initialCredential.expiresAt?.toISOString() ?? null
      }
    };
    c.header("Cache-Control", "no-store");
    return c.json(response, 201);
  });

  return app;
}

/** Project-scoped quota management, mounted only after ownerProjectAuth. */
export function projectQuotasRoutes(deps: ProjectsDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.patch("/quotas", async (c) => {
    const parsed = updateProjectQuotasRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }

    const targetId = c.get("projectId");

    // Zod's z.optional() types an omitted field as `undefined`-valued,
    // but ProjectQuotas (exactOptionalPropertyTypes: true) requires the
    // key to be genuinely ABSENT to mean "leave unchanged" — spreading
    // parsed.data directly would pass `rateLimitPerMinute: undefined`
    // for an omitted field, which setProjectQuotas would treat as "the
    // caller explicitly provided this key" rather than "not provided".
    const quotas: Parameters<typeof setProjectQuotas>[2] = {
      ...("rateLimitPerMinute" in parsed.data && { rateLimitPerMinute: parsed.data.rateLimitPerMinute ?? null }),
      ...("retentionDays" in parsed.data && { retentionDays: parsed.data.retentionDays ?? null }),
      ...("traceQuietPeriodSeconds" in parsed.data && {
        traceQuietPeriodSeconds: parsed.data.traceQuietPeriodSeconds ?? null
      })
    };

    const updated = await setProjectQuotas(deps.pool, targetId, quotas);
    if (!updated) {
      return c.json({ error: "project not found" }, 404);
    }
    return c.json(toResponse(updated), 200);
  });

  return app;
}
