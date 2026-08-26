import {
  createOtlpForwardRule,
  deleteOtlpForwardRule,
  listOtlpForwardRules,
  updateOtlpForwardRule,
  type OtlpForwardRule
} from "@ironside/db";
import {
  createOtlpForwardRuleRequestSchema,
  encryptSecret,
  updateOtlpForwardRuleRequestSchema,
  type ListOtlpForwardRulesResponse,
  type OtlpForwardRuleResponse
} from "@ironside/shared";
import { Hono } from "hono";
import type { Pool } from "pg";
import { ulid } from "ulid";
import type { AuthEnv } from "../middleware/auth.js";
import { toEnabledPollIntervalUpdate, toFilter } from "../lib/exact-optional.js";

export interface ForwardsDeps {
  pool: Pool;
}

// Day-2 CRUD for otlp_forward_rules — same encrypt-on-write,
// never-echo-back pattern as exports.ts. destinationUrl itself is NOT a
// secret (it's validated for SSRF at forward-time by
// apps/worker/src/lib/ssrf-guard.ts, applied in M6-04) and IS returned.
function toResponse(rule: OtlpForwardRule): OtlpForwardRuleResponse {
  return {
    id: rule.id,
    projectId: rule.projectId,
    name: rule.name,
    destinationUrl: rule.destinationUrl,
    hasDestinationAuthHeader: rule.destinationAuthHeaderEncrypted !== null,
    filter: rule.filter,
    enabled: rule.enabled,
    pollIntervalSeconds: rule.pollIntervalSeconds,
    nextRunAt: rule.nextRunAt.toISOString()
  };
}

export function forwardsRoutes(deps: ForwardsDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/otlp-forwards", async (c) => {
    const rules = await listOtlpForwardRules(deps.pool, c.get("projectId"));
    const response: ListOtlpForwardRulesResponse = { forwards: rules.map(toResponse) };
    return c.json(response, 200);
  });

  app.post("/otlp-forwards", async (c) => {
    const parsed = createOtlpForwardRuleRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const body = parsed.data;
    const projectId = c.get("projectId");

    const created = await createOtlpForwardRule(deps.pool, {
      id: `fwd_${ulid()}`,
      projectId,
      name: body.name,
      destinationUrl: body.destinationUrl,
      filter: toFilter(body.filter),
      ...(body.destinationAuthHeader && {
        destinationAuthHeaderEncrypted: encryptSecret(body.destinationAuthHeader)
      })
    });

    const final = body.pollIntervalSeconds
      ? await updateOtlpForwardRule(deps.pool, projectId, created.id, {
          pollIntervalSeconds: body.pollIntervalSeconds
        })
      : created;

    return c.json(toResponse(final ?? created), 201);
  });

  app.patch("/otlp-forwards/:id", async (c) => {
    const parsed = updateOtlpForwardRuleRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }

    const updated = await updateOtlpForwardRule(
      deps.pool,
      c.get("projectId"),
      c.req.param("id"),
      toEnabledPollIntervalUpdate(parsed.data)
    );
    if (!updated) {
      return c.json({ error: "OTLP forward rule not found" }, 404);
    }
    return c.json(toResponse(updated), 200);
  });

  app.delete("/otlp-forwards/:id", async (c) => {
    const deleted = await deleteOtlpForwardRule(deps.pool, c.get("projectId"), c.req.param("id"));
    if (!deleted) {
      return c.json({ error: "OTLP forward rule not found" }, 404);
    }
    return c.body(null, 204);
  });

  return app;
}
