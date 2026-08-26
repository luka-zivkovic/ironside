import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { listProjectsLimited } from "../src/projects.js";

describe("listProjectsLimited", () => {
  it("pushes the sentinel limit into Postgres instead of materializing the registry", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await listProjectsLimited({ query } as unknown as Pool, 101);

    expect(query).toHaveBeenCalledWith(
      "select * from projects order by created_at asc, id asc limit $1",
      [101]
    );
  });
});
