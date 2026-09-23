import { describe, expect, it } from "vitest";
import {
  COST_MODEL_METADATA_KEY,
  COST_SOURCE_METADATA_KEY,
  COST_TABLE_METADATA_KEY,
  computeCostDetails,
  enrichObservationCost,
  loadPriceTable,
  modelNameCandidates,
  resolveModelPrice,
  type PriceTable
} from "../src/index.js";

const table: PriceTable = {
  source: "test",
  syncedAt: "2026-09-11",
  models: {
    "claude-sonnet-4-5": { provider: "anthropic", input: 3e-6, output: 15e-6, cache_read: 3e-7, cache_write: 3.75e-6 },
    "gpt-4o-mini": { provider: "openai", input: 1.5e-7, output: 6e-7, cache_read: 7.5e-8 },
    "gemini/gemini-2.5-pro": { provider: "gemini", input: 1.25e-6, output: 1e-5 },
    "text-embedding-3-small": { provider: "openai", input: 2e-8 }
  }
};

describe("model name candidates", () => {
  it("tries the reported name, then progressively looser forms, then provider prefixes", () => {
    const candidates = modelNameCandidates("Anthropic/Claude-Sonnet-4-5-20250929");
    expect(candidates.slice(0, 4)).toEqual([
      "Anthropic/Claude-Sonnet-4-5-20250929",
      "anthropic/claude-sonnet-4-5-20250929",
      "claude-sonnet-4-5-20250929",
      "anthropic/claude-sonnet-4-5"
    ]);
    expect(candidates).toContain("claude-sonnet-4-5");
    expect(candidates).toContain("gemini/claude-sonnet-4-5");
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe("resolveModelPrice", () => {
  it("matches exact table keys and provider-prefixed keys from a bare name", () => {
    expect(resolveModelPrice("gpt-4o-mini", { table })?.matchedKey).toBe("gpt-4o-mini");
    expect(resolveModelPrice("gemini-2.5-pro", { table })).toMatchObject({
      source: "table",
      matchedKey: "gemini/gemini-2.5-pro",
      tableVersion: "2026-09-11"
    });
  });

  it("strips date suffixes and provider prefixes before giving up", () => {
    expect(resolveModelPrice("claude-sonnet-4-5-20250929", { table })?.matchedKey).toBe("claude-sonnet-4-5");
    expect(resolveModelPrice("anthropic/claude-sonnet-4-5", { table })?.matchedKey).toBe("claude-sonnet-4-5");
    expect(resolveModelPrice("openai/gpt-4o-mini-2024-07-18", { table })?.matchedKey).toBe("gpt-4o-mini");
  });

  it("returns null for unknown models instead of a zero price", () => {
    expect(resolveModelPrice("my-private-finetune", { table })).toBeNull();
  });

  it("prefers project overrides in list order and ignores invalid patterns", () => {
    const overrides = [
      { pattern: "(", input: 1, output: 1 },
      { pattern: "^my-private-", input: 2e-6, output: 8e-6 },
      { pattern: "^gpt-4o", input: 0, output: 0 }
    ];
    expect(resolveModelPrice("my-private-finetune-v3", { table, overrides })).toEqual({
      price: { input: 2e-6, output: 8e-6 },
      source: "override",
      matchedKey: "^my-private-"
    });
    expect(resolveModelPrice("GPT-4o-mini", { table, overrides })).toMatchObject({
      source: "override",
      matchedKey: "^gpt-4o"
    });
  });
});

describe("computeCostDetails", () => {
  it("prices each reported component and sums a total", () => {
    const cost = computeCostDetails(
      { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, total_tokens: 6200 },
      table.models["claude-sonnet-4-5"]!
    );
    expect(cost).toEqual({ input: 0.003, output: 0.003, cache_read: 0.0015, total: 0.0075 });
  });

  it("omits components the price table cannot cover and rejects usage it cannot price", () => {
    expect(computeCostDetails({ input_tokens: 10, cache_creation_input_tokens: 10 }, table.models["gpt-4o-mini"]!)).toEqual({
      input: 1.5e-6,
      total: 1.5e-6
    });
    expect(computeCostDetails({ reasoning_tokens: 10 }, table.models["gpt-4o-mini"]!)).toBeNull();
    expect(computeCostDetails({ input_tokens: 100 }, table.models["text-embedding-3-small"]!)).toEqual({
      input: 2e-6,
      total: 2e-6
    });
  });
});

describe("enrichObservationCost", () => {
  it("fills cost and provenance for a priced model with usage and no cost", () => {
    const observation = {
      model: "gpt-4o-mini",
      usageDetails: { input_tokens: 2000, output_tokens: 500 },
      metadata: { existing: "kept" }
    };
    expect(enrichObservationCost(observation, { table })).toBe(true);
    expect(observation).toMatchObject({
      costDetails: { input: 0.0003, output: 0.0003, total: 0.0006 },
      metadata: {
        existing: "kept",
        [COST_SOURCE_METADATA_KEY]: "table",
        [COST_MODEL_METADATA_KEY]: "gpt-4o-mini",
        [COST_TABLE_METADATA_KEY]: "2026-09-11"
      }
    });
  });

  it("never overrides client-sent cost, and leaves unpriceable observations untouched", () => {
    const clientPriced = {
      model: "gpt-4o-mini",
      usageDetails: { input_tokens: 2000 },
      costDetails: { total: 0.42 },
      metadata: {}
    };
    expect(enrichObservationCost(clientPriced, { table })).toBe(false);
    expect(clientPriced.costDetails).toEqual({ total: 0.42 });
    expect(clientPriced.metadata).toEqual({});

    const noModel = { usageDetails: { input_tokens: 1 }, metadata: {} as Record<string, string> };
    expect(enrichObservationCost(noModel, { table })).toBe(false);
    const unknown = { model: "unknown-model", usageDetails: { input_tokens: 1 }, metadata: {} as Record<string, string> };
    expect(enrichObservationCost(unknown, { table })).toBe(false);
    expect(unknown).not.toHaveProperty("costDetails");
  });

  it("records the override pattern instead of a table version for override matches", () => {
    const observation = { model: "custom-llm", usageDetails: { input_tokens: 10, output_tokens: 10 }, metadata: {} };
    enrichObservationCost(observation, { table, overrides: [{ pattern: "^custom-", input: 1e-6, output: 2e-6 }] });
    expect(observation.metadata).toEqual({
      [COST_SOURCE_METADATA_KEY]: "override",
      [COST_MODEL_METADATA_KEY]: "^custom-"
    });
    expect(observation).toMatchObject({ costDetails: { input: 1e-5, output: 2e-5, total: 3e-5 } });
  });
});

describe("vendored price table", () => {
  it("loads, records its sync date, and prices the models the SDK wrappers commonly report", () => {
    const vendored = loadPriceTable();
    expect(vendored.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(vendored.models).length).toBeGreaterThan(1000);
    for (const model of ["gpt-4o-mini", "claude-sonnet-4-5", "claude-haiku-4-5-20251001", "gemini-2.5-pro"]) {
      const resolved = resolveModelPrice(model);
      expect(resolved, model).not.toBeNull();
      expect(resolved?.price.input).toBeGreaterThan(0);
      expect(resolved?.price.output).toBeGreaterThan(0);
    }
  });
});
