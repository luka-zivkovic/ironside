import {
  createWebhookRule,
  deleteWebhookRule,
  listWebhookRules,
  updateWebhookRule,
  type WebhookRule
} from "@ironside/db";
import {
  createWebhookRuleRequestSchema,
  encryptSecret,
  updateWebhookRuleRequestSchema,
  type ListWebhookRulesResponse,
  type WebhookRuleResponse
} from "@ironside/shared";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { Pool } from "pg";
import { ulid } from "ulid";
import type { AuthEnv } from "../middleware/auth.js";
import { toEnabledPollIntervalUpdate, toFilter } from "../lib/exact-optional.js";

export interface WebhookRulesDeps {
  pool: Pool;
}

// Day-2 CRUD for webhook_rules — same encrypt-on-write pattern as
// exports.ts/forwards.ts. Unlike the OTLP forward auth header (optional),
// a webhook's HMAC signing secret is REQUIRED by the domain (webhook-
// runner.ts always signs) but never supplied by the caller — generated
// server-side, same as a machine credential token, since there's no reason a
// caller should ever choose or see it: the receiver only needs to verify
// signatures, never construct one themselves outside Ironside.
function toResponse(rule: WebhookRule): WebhookRuleResponse {
  return {
    id: rule.id,
    projectId: rule.projectId,
    name: rule.name,
    destinationUrl: rule.destinationUrl,
    filter: rule.filter,
    enabled: rule.enabled,
    pollIntervalSeconds: rule.pollIntervalSeconds,
    nextRunAt: rule.nextRunAt.toISOString()
  };
}

export function webhookRulesRoutes(deps: WebhookRulesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/webhooks", async (c) => {
    const rules = await listWebhookRules(deps.pool, c.get("projectId"));
    const response: ListWebhookRulesResponse = { webhooks: rules.map(toResponse) };
    return c.json(response, 200);
  });

  app.post("/webhooks", async (c) => {
    const parsed = createWebhookRuleRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const body = parsed.data;
    const projectId = c.get("projectId");

    const created = await createWebhookRule(deps.pool, {
      id: `webhook_${ulid()}`,
      projectId,
      name: body.name,
      destinationUrl: body.destinationUrl,
      filter: toFilter(body.filter),
      signingSecretEncrypted: encryptSecret(randomBytes(32).toString("hex"))
    });

    const final = body.pollIntervalSeconds
      ? await updateWebhookRule(deps.pool, projectId, created.id, {
          pollIntervalSeconds: body.pollIntervalSeconds
        })
      : created;

    return c.json(toResponse(final ?? created), 201);
  });

  app.patch("/webhooks/:id", async (c) => {
    const parsed = updateWebhookRuleRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }

    const updated = await updateWebhookRule(
      deps.pool,
      c.get("projectId"),
      c.req.param("id"),
      toEnabledPollIntervalUpdate(parsed.data)
    );
    if (!updated) {
      return c.json({ error: "webhook rule not found" }, 404);
    }
    return c.json(toResponse(updated), 200);
  });

  app.delete("/webhooks/:id", async (c) => {
    const deleted = await deleteWebhookRule(deps.pool, c.get("projectId"), c.req.param("id"));
    if (!deleted) {
      return c.json({ error: "webhook rule not found" }, 404);
    }
    return c.body(null, 204);
  });

  return app;
}
