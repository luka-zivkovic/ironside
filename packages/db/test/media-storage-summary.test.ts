import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";
import { summarizeMediaStorage } from "../src/media-assets.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://ironside:ironside@localhost:5433/ironside"
});
const organizationId = `org_media_summary_${crypto.randomUUID()}`;
const projectId = `proj_media_summary_${crypto.randomUUID()}`;

beforeAll(async () => {
  await runMigrations(pool);
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    organizationId,
    "media-summary-test"
  ]);
  await pool.query("insert into projects (id, organization_id, name) values ($1, $2, $3)", [
    projectId,
    organizationId,
    "media-summary-project"
  ]);
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [organizationId]);
  await pool.end();
});

describe("summarizeMediaStorage", () => {
  it("does no instance-wide scan when no projects are selected", async () => {
    await expect(summarizeMediaStorage(pool, [])).resolves.toEqual([]);
  });

  it("reports per-project asset count and bytes without implying reachability", async () => {
    await pool.query(
      `insert into media_assets
         (id, project_id, sha256, content_type, size_bytes, object_key, created_at)
       values
         ($1, $3, $4, 'image/png', 120, $6, '2026-01-01T00:00:00Z'),
         ($2, $3, $5, 'image/png', 80, $7, '2026-02-01T00:00:00Z')`,
      [
        `media_${crypto.randomUUID()}`,
        `media_${crypto.randomUUID()}`,
        projectId,
        crypto.randomUUID().replaceAll("-", ""),
        crypto.randomUUID().replaceAll("-", ""),
        `media/${projectId}/a`,
        `media/${projectId}/b`
      ]
    );

    const summaries = await summarizeMediaStorage(pool, [projectId]);

    expect(summaries.find((summary) => summary.projectId === projectId)).toEqual({
      projectId,
      assetCount: 2,
      sizeBytes: 200,
      oldestCreatedAt: "2026-01-01T00:00:00.000Z"
    });
  });
});
