import type { Pool } from "pg";
import { ulid } from "ulid";

/** USD per token; null = this override does not price that component. */
export interface ProjectModelPrice {
  id: string;
  projectId: string;
  position: number;
  pattern: string;
  inputCostPerToken: number | null;
  outputCostPerToken: number | null;
  cacheReadInputTokenCost: number | null;
  cacheWriteInputTokenCost: number | null;
}

export type ProjectModelPriceInput = Omit<ProjectModelPrice, "id" | "projectId" | "position">;

interface Row {
  id: string;
  project_id: string;
  position: number;
  pattern: string;
  input_cost_per_token: string | null;
  output_cost_per_token: string | null;
  cache_read_input_token_cost: string | null;
  cache_write_input_token_cost: string | null;
}

// numeric columns arrive as strings from pg; prices are small USD fractions
// well within double precision.
function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function fromRow(row: Row): ProjectModelPrice {
  return {
    id: row.id,
    projectId: row.project_id,
    position: row.position,
    pattern: row.pattern,
    inputCostPerToken: numberOrNull(row.input_cost_per_token),
    outputCostPerToken: numberOrNull(row.output_cost_per_token),
    cacheReadInputTokenCost: numberOrNull(row.cache_read_input_token_cost),
    cacheWriteInputTokenCost: numberOrNull(row.cache_write_input_token_cost)
  };
}

export async function listProjectModelPrices(pool: Pool, projectId: string): Promise<ProjectModelPrice[]> {
  const result = await pool.query<Row>(
    "select * from project_model_prices where project_id = $1 order by position asc",
    [projectId]
  );
  return result.rows.map(fromRow);
}

/**
 * Replaces the project's whole override list atomically. The list is small
 * and order-sensitive (first match wins), so whole-list replacement is
 * simpler and safer than per-row edits that would need reordering.
 */
export async function replaceProjectModelPrices(
  pool: Pool,
  projectId: string,
  overrides: ProjectModelPriceInput[]
): Promise<ProjectModelPrice[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("delete from project_model_prices where project_id = $1", [projectId]);
    const inserted: ProjectModelPrice[] = [];
    for (const [position, override] of overrides.entries()) {
      const result = await client.query<Row>(
        `insert into project_model_prices (
           id, project_id, position, pattern,
           input_cost_per_token, output_cost_per_token,
           cache_read_input_token_cost, cache_write_input_token_cost
         ) values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [
          `mprice_${ulid()}`,
          projectId,
          position,
          override.pattern,
          override.inputCostPerToken,
          override.outputCostPerToken,
          override.cacheReadInputTokenCost,
          override.cacheWriteInputTokenCost
        ]
      );
      inserted.push(fromRow(result.rows[0]!));
    }
    await client.query("commit");
    return inserted;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
