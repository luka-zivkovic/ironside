// Refreshes data/model-prices.json from LiteLLM's community-maintained
// pricing table, keeping only the fields Ironside prices with. Run from the
// repo root: `node packages/pricing/scripts/sync-model-prices.mjs`.
// The table is vendored (not fetched at runtime) so an installation's cost
// numbers are reproducible for a given Ironside release; see
// spec/cost-pricing-v1.md for the refresh policy.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const response = await fetch(SOURCE_URL);
if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
const upstream = await response.json();

const models = {};
for (const [name, entry] of Object.entries(upstream)) {
  if (name === "sample_spec" || !entry || typeof entry !== "object") continue;
  const input = numberOrUndefined(entry.input_cost_per_token);
  const output = numberOrUndefined(entry.output_cost_per_token);
  if (input === undefined && output === undefined) continue;
  models[name] = {
    provider: typeof entry.litellm_provider === "string" ? entry.litellm_provider : "unknown",
    ...(input !== undefined && { input }),
    ...(output !== undefined && { output }),
    ...(numberOrUndefined(entry.cache_read_input_token_cost) !== undefined && {
      cache_read: entry.cache_read_input_token_cost
    }),
    ...(numberOrUndefined(entry.cache_creation_input_token_cost) !== undefined && {
      cache_write: entry.cache_creation_input_token_cost
    })
  };
}

const table = {
  source: SOURCE_URL,
  syncedAt: new Date().toISOString().slice(0, 10),
  models: Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)))
};

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "model-prices.json");
await writeFile(target, `${JSON.stringify(table, null, 1)}\n`);
console.log(`wrote ${Object.keys(models).length} priced models to ${target}`);

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
