import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** USD per token. Absent component = the table has no price for it (never zero). */
export interface ModelPrice {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface PriceTable {
  /** Upstream document the table was trimmed from. */
  source: string;
  /** ISO date of the last sync; recorded on every computed cost for provenance. */
  syncedAt: string;
  models: Record<string, ModelPrice & { provider: string }>;
}

// __dirname is dist/src at runtime; the build script copies data/ next to it
// (same convention as packages/db's migrations).
const __dirname = dirname(fileURLToPath(import.meta.url));

let cached: PriceTable | null = null;

export function loadPriceTable(): PriceTable {
  if (cached) return cached;
  const raw = readFileSync(join(__dirname, "..", "data", "model-prices.json"), "utf8");
  cached = JSON.parse(raw) as PriceTable;
  return cached;
}
