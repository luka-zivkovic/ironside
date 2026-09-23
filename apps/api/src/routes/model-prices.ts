import { listProjectModelPrices, replaceProjectModelPrices, type ProjectModelPrice } from "@ironside/db";
import { loadPriceTable } from "@ironside/pricing";
import {
  replaceModelPricesRequestSchema,
  type ModelPriceOverride,
  type ModelPricesResponse
} from "@ironside/shared";
import { Hono } from "hono";
import type { Pool } from "pg";
import type { AuthEnv } from "../middleware/auth.js";

export interface ModelPricesDeps {
  pool: Pool;
}

function toResponse(override: ProjectModelPrice): ModelPriceOverride {
  return {
    id: override.id,
    pattern: override.pattern,
    inputCostPerToken: override.inputCostPerToken,
    outputCostPerToken: override.outputCostPerToken,
    cacheReadInputTokenCost: override.cacheReadInputTokenCost,
    cacheWriteInputTokenCost: override.cacheWriteInputTokenCost
  };
}

function tableSummary(): ModelPricesResponse["table"] {
  const table = loadPriceTable();
  return { source: table.source, syncedAt: table.syncedAt, modelCount: Object.keys(table.models).length };
}

/**
 * Project-scoped model price overrides (spec/cost-pricing-v1.md), mounted
 * only after ownerProjectAuth. The list is replaced whole because order is
 * part of the contract (first matching pattern wins).
 */
export function modelPricesRoutes(deps: ModelPricesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/model-prices", async (c) => {
    const overrides = await listProjectModelPrices(deps.pool, c.get("projectId"));
    const response: ModelPricesResponse = { overrides: overrides.map(toResponse), table: tableSummary() };
    return c.json(response, 200);
  });

  app.put("/model-prices", async (c) => {
    const parsed = replaceModelPricesRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const overrides = await replaceProjectModelPrices(deps.pool, c.get("projectId"), parsed.data.overrides);
    const response: ModelPricesResponse = { overrides: overrides.map(toResponse), table: tableSummary() };
    return c.json(response, 200);
  });

  return app;
}
