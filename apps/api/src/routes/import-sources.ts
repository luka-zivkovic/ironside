import {
  deleteImportSource,
  listImportSources,
  updateImportSource,
  upsertImportSource,
  type ImportSourceConfig
} from "@ironside/db";
import {
  createImportSourceRequestSchema,
  encryptSecret,
  updateImportSourceRequestSchema,
  type ImportSourceResponse,
  type ListImportSourcesResponse
} from "@ironside/shared";
import { Hono } from "hono";
import type { Pool } from "pg";
import { ulid } from "ulid";
import type { AuthEnv } from "../middleware/auth.js";
import { toEnabledPollIntervalUpdate } from "../lib/exact-optional.js";

export interface ImportSourcesDeps {
  pool: Pool;
}

// Day-2 CRUD for import_sources — the credentials + scheduling
// apps/worker's scheduler (M5-07) needs to run runLangfuseImport/
// runLangsmithImport automatically. Same write-only-secrets, never-
// echoed-back pattern as exports/otlp-forwards/webhooks; the provider's
// entire credential object (LangFuse: publicKey+secretKey+baseUrl;
// LangSmith: apiKey+baseUrl?+sessionIds) is encrypted as one JSON blob,
// matching import_sources' encrypted_credentials column shape.
function toResponse(source: ImportSourceConfig): ImportSourceResponse {
  return {
    id: source.id,
    projectId: source.projectId,
    provider: source.provider,
    enabled: source.enabled,
    pollIntervalSeconds: source.pollIntervalSeconds,
    nextRunAt: source.nextRunAt.toISOString()
  };
}

export function importSourcesRoutes(deps: ImportSourcesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/import-sources", async (c) => {
    const sources = await listImportSources(deps.pool, c.get("projectId"));
    const response: ListImportSourcesResponse = { importSources: sources.map(toResponse) };
    return c.json(response, 200);
  });

  // POST upserts by (projectId, provider) — connecting the same provider
  // twice (e.g. rotating credentials) replaces the existing source rather
  // than erroring on a uniqueness conflict the caller would then have to
  // resolve by finding and deleting the old row first.
  app.post("/import-sources", async (c) => {
    const parsed = createImportSourceRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const { pollIntervalSeconds, ...credentials } = parsed.data;
    const projectId = c.get("projectId");

    const upserted = await upsertImportSource(deps.pool, {
      id: `import_src_${ulid()}`,
      projectId,
      provider: credentials.provider,
      encryptedCredentials: encryptSecret(JSON.stringify(credentials)),
      ...(pollIntervalSeconds !== undefined && { pollIntervalSeconds })
    });

    return c.json(toResponse(upserted), 201);
  });

  app.patch("/import-sources/:id", async (c) => {
    const parsed = updateImportSourceRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }

    const updated = await updateImportSource(
      deps.pool,
      c.get("projectId"),
      c.req.param("id"),
      toEnabledPollIntervalUpdate(parsed.data)
    );
    if (!updated) {
      return c.json({ error: "import source not found" }, 404);
    }
    return c.json(toResponse(updated), 200);
  });

  app.delete("/import-sources/:id", async (c) => {
    const deleted = await deleteImportSource(deps.pool, c.get("projectId"), c.req.param("id"));
    if (!deleted) {
      return c.json({ error: "import source not found" }, 404);
    }
    return c.body(null, 204);
  });

  return app;
}
