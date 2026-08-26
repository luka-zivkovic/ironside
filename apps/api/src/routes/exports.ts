import {
  createExportConfig,
  deleteExportConfig,
  listExportConfigs,
  updateExportConfig,
  type ExportConfig
} from "@ironside/db";
import {
  createExportConfigRequestSchema,
  encryptSecret,
  updateExportConfigRequestSchema,
  type ExportConfigResponse,
  type ListExportConfigsResponse
} from "@ironside/shared";
import { Hono } from "hono";
import type { Pool } from "pg";
import { ulid } from "ulid";
import type { AuthEnv } from "../middleware/auth.js";
import { toEnabledPollIntervalUpdate, toFilter } from "../lib/exact-optional.js";

export interface ExportsDeps {
  pool: Pool;
}

// Day-2 CRUD for export_configs — the destinations apps/worker's scheduler
// (M6-05) polls automatically. The plaintext destinationSecretAccessKey
// never survives past the create request: encrypted here (same
// encryptSecret the worker's scheduler decrypts with) before it ever
// reaches Postgres, and never echoed back in any response (toResponse
// below has no field for it at all — not just "not returned this time").
function toResponse(config: ExportConfig): ExportConfigResponse {
  return {
    id: config.id,
    projectId: config.projectId,
    name: config.name,
    format: config.format,
    filter: config.filter,
    destinationBucket: config.destinationBucket,
    destinationPrefix: config.destinationPrefix,
    destinationEndpoint: config.destinationEndpoint,
    destinationRegion: config.destinationRegion,
    destinationAccessKeyId: config.destinationAccessKeyId,
    enabled: config.enabled,
    pollIntervalSeconds: config.pollIntervalSeconds,
    nextRunAt: config.nextRunAt.toISOString(),
    lastRunAt: config.lastRunAt ? config.lastRunAt.toISOString() : null,
    lastRunStatus: config.lastRunStatus,
    lastRunError: config.lastRunError,
    lastRunRowCount: config.lastRunRowCount
  };
}

export function exportsRoutes(deps: ExportsDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/exports", async (c) => {
    const configs = await listExportConfigs(deps.pool, c.get("projectId"));
    const response: ListExportConfigsResponse = { exports: configs.map(toResponse) };
    return c.json(response, 200);
  });

  app.post("/exports", async (c) => {
    const parsed = createExportConfigRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const body = parsed.data;
    const projectId = c.get("projectId");

    const created = await createExportConfig(deps.pool, {
      id: `export_${ulid()}`,
      projectId,
      name: body.name,
      format: body.format,
      filter: toFilter(body.filter),
      destinationBucket: body.destinationBucket,
      destinationPrefix: body.destinationPrefix,
      destinationEndpoint: body.destinationEndpoint,
      destinationRegion: body.destinationRegion,
      destinationAccessKeyId: body.destinationAccessKeyId,
      destinationSecretAccessKeyEncrypted: encryptSecret(body.destinationSecretAccessKey)
    });

    // pollIntervalSeconds has no column in the INSERT (defaults to the
    // subsystem default from the Postgres baseline) — apply the caller's
    // override, if any, as an immediate follow-up update rather than
    // widening createExportConfig's own insert statement for one
    // optional field only this route ever sets.
    const final = body.pollIntervalSeconds
      ? await updateExportConfig(deps.pool, projectId, created.id, {
          pollIntervalSeconds: body.pollIntervalSeconds
        })
      : created;

    return c.json(toResponse(final ?? created), 201);
  });

  app.patch("/exports/:id", async (c) => {
    const parsed = updateExportConfigRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }

    const updated = await updateExportConfig(
      deps.pool,
      c.get("projectId"),
      c.req.param("id"),
      toEnabledPollIntervalUpdate(parsed.data)
    );
    if (!updated) {
      return c.json({ error: "export config not found" }, 404);
    }
    return c.json(toResponse(updated), 200);
  });

  app.delete("/exports/:id", async (c) => {
    const deleted = await deleteExportConfig(deps.pool, c.get("projectId"), c.req.param("id"));
    if (!deleted) {
      return c.json({ error: "export config not found" }, 404);
    }
    return c.body(null, 204);
  });

  return app;
}
