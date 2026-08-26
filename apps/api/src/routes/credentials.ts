import {
  createMachineCredentialRequestSchema,
  type CreatedMachineCredential,
  type ListMachineCredentialsResponse,
  type MachineCredentialSummary
} from "@ironside/shared";
import { Hono } from "hono";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import type { OwnerProjectEnv } from "../middleware/owner-session.js";
import {
  createMachineCredential,
  listMachineCredentials,
  revokeMachineCredential,
  type MachineCredentialSummaryRow
} from "../lib/machine-credentials.js";

export interface CredentialsDeps {
  pool: Pool;
  redis: Redis;
}

function toSummary(row: MachineCredentialSummaryRow): MachineCredentialSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    preset: row.preset,
    capabilities: row.capabilities,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy
  };
}

/** Owner-only credential lifecycle for the explicit, authorized project. */
export function credentialsRoutes(deps: CredentialsDeps): Hono<OwnerProjectEnv> {
  const app = new Hono<OwnerProjectEnv>();

  app.get("/credentials", async (c) => {
    const rows = await listMachineCredentials(deps.pool, c.get("projectId"));
    const response: ListMachineCredentialsResponse = { credentials: rows.map(toSummary) };
    c.header("Cache-Control", "no-store");
    return c.json(response, 200);
  });

  app.post("/credentials", async (c) => {
    const parsed = createMachineCredentialRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now() + 1_000) {
      return c.json({ error: "expiresAt must be at least one second in the future" }, 400);
    }
    const owner = c.get("ownerSession");
    const created = await createMachineCredential(deps.pool, {
      projectId: c.get("projectId"),
      organizationId: owner.organizationId,
      name: parsed.data.name,
      preset: parsed.data.preset,
      expiresAt,
      actor: { principalId: owner.principalId, username: owner.username }
    });
    const response: CreatedMachineCredential = {
      ...toSummary(created),
      token: created.token
    };
    c.header("Cache-Control", "no-store");
    return c.json(response, 201);
  });

  app.delete("/credentials/:id", async (c) => {
    const owner = c.get("ownerSession");
    const revoked = await revokeMachineCredential(deps.pool, deps.redis, {
      projectId: c.get("projectId"),
      organizationId: owner.organizationId,
      credentialId: c.req.param("id"),
      actor: { principalId: owner.principalId, username: owner.username }
    });
    if (!revoked) return c.json({ error: "credential not found" }, 404);
    return c.body(null, 204);
  });

  return app;
}
