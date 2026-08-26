import { Pool } from "pg";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";
import {
  claimDueImportSources,
  deleteImportSource,
  listImportSources,
  updateImportSource,
  upsertImportSource
} from "../src/import-sources.js";

// Same claim/reschedule contract as scheduling.test.ts's
// claimDueExportConfigs (due/not-due/disabled selection, next_run_at
// advancing on claim, concurrent-claim exclusivity) — verified in full
// here since import_sources' upsert-by-(project,provider) semantics are
// new and not shared by the other three claim tables.
//
// Every test uses its OWN freshly-created project (not one shared
// projectId), unlike scheduling.test.ts's export/forward/webhook tests —
// import_sources upserts by (project_id, provider), so two tests sharing
// one project and the same provider would silently collapse onto the
// same row and corrupt each other's assertions (found empirically: this
// was the file's first version, which failed non-deterministically until
// traced to exactly this collision).

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://ironside:ironside@localhost:5433/ironside"
});

let orgId: string;

beforeAll(async () => {
  await runMigrations(pool);
  orgId = `org_${ulid()}`;
  await pool.query("insert into organizations (id, name) values ($1, $2)", [
    orgId,
    "import-sources-db-test-org"
  ]);
});

afterAll(async () => {
  await pool.query("delete from organizations where name = 'import-sources-db-test-org'");
  await pool.end();
});

async function freshProject(): Promise<string> {
  const projectId = `proj_${ulid()}`;
  await pool.query(
    "insert into projects (id, organization_id, name) values ($1, $2, $3)",
    [projectId, orgId, `import-sources-db-test-${projectId}`]
  );
  return projectId;
}

describe("upsertImportSource", () => {
  it("creates a new source, defaulting enabled=true and due immediately", async () => {
    const projectId = await freshProject();
    const source = await upsertImportSource(pool, {
      id: `import_src_${ulid()}`,
      projectId,
      provider: "langfuse",
      encryptedCredentials: "unused-in-this-test"
    });
    expect(source.provider).toBe("langfuse");
    expect(source.enabled).toBe(true);
    expect(source.pollIntervalSeconds).toBe(3600);
    expect(source.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("connecting the SAME provider again replaces the existing row (upsert), not a duplicate", async () => {
    const projectId = await freshProject();
    const first = await upsertImportSource(pool, {
      id: `import_src_${ulid()}`,
      projectId,
      provider: "langsmith",
      encryptedCredentials: "old-credentials"
    });
    const second = await upsertImportSource(pool, {
      id: `import_src_${ulid()}`, // deliberately a DIFFERENT id — proves the row is matched by (project, provider), not id
      projectId,
      provider: "langsmith",
      encryptedCredentials: "new-credentials"
    });

    // The ORIGINAL row's id is preserved (excluded.* update, not a fresh
    // insert), same "id stays stable across upsert" contract as
    // claimWebhookDelivery's retry semantics.
    expect(second.id).toBe(first.id);
    expect(second.encryptedCredentials).toBe("new-credentials");

    const all = await listImportSources(pool, projectId);
    expect(all).toHaveLength(1);
  });

  it("re-upserting re-enables a previously-disabled source", async () => {
    const projectId = await freshProject();
    const created = await upsertImportSource(pool, {
      id: `import_src_${ulid()}`,
      projectId,
      provider: "langfuse",
      encryptedCredentials: "c1",
      pollIntervalSeconds: 999
    });
    await updateImportSource(pool, projectId, created.id, { enabled: false });

    const reconnected = await upsertImportSource(pool, {
      id: `import_src_${ulid()}`,
      projectId,
      provider: "langfuse",
      encryptedCredentials: "c2"
    });
    expect(reconnected.enabled).toBe(true);
  });

  it("respects a caller-supplied pollIntervalSeconds on first create", async () => {
    const projectId = await freshProject();
    const source = await upsertImportSource(pool, {
      id: `import_src_${ulid()}`,
      projectId,
      provider: "langsmith",
      encryptedCredentials: "c",
      pollIntervalSeconds: 7200
    });
    expect(source.pollIntervalSeconds).toBe(7200);
  });
});

describe("claimDueImportSources", () => {
  it("claims a newly-created source and advances next_run_at, so it isn't claimed again immediately", async () => {
    const projectId = await freshProject();
    const source = await upsertImportSource(pool, {
      id: `import_src_${ulid()}`,
      projectId,
      provider: "langfuse",
      encryptedCredentials: "unused"
    });

    const first = await claimDueImportSources(pool, 100);
    expect(first.map((s) => s.id)).toContain(source.id);

    const second = await claimDueImportSources(pool, 100);
    expect(second.map((s) => s.id)).not.toContain(source.id);
  });

  it("a disabled source is never claimed even when due", async () => {
    const projectId = await freshProject();
    const source = await upsertImportSource(pool, {
      id: `import_src_${ulid()}`,
      projectId,
      provider: "langsmith",
      encryptedCredentials: "unused"
    });
    await updateImportSource(pool, projectId, source.id, { enabled: false });

    const due = await claimDueImportSources(pool, 1000);
    expect(due.map((s) => s.id)).not.toContain(source.id);
  });

  it("concurrent claim ticks never claim the same due row twice (FOR UPDATE SKIP LOCKED)", async () => {
    const projectId = await freshProject();
    const source = await upsertImportSource(pool, {
      id: `import_src_${ulid()}`,
      projectId,
      provider: "langfuse",
      encryptedCredentials: "unused"
    });

    const [batchA, batchB] = await Promise.all([
      claimDueImportSources(pool, 100),
      claimDueImportSources(pool, 100)
    ]);
    const claimedBoth = [...batchA, ...batchB].filter((s) => s.id === source.id);
    expect(claimedBoth).toHaveLength(1);
  });
});

describe("deleteImportSource", () => {
  it("is project-scoped: another project's id is not found", async () => {
    const projectId = await freshProject();
    const source = await upsertImportSource(pool, {
      id: `import_src_${ulid()}`,
      projectId,
      provider: "langfuse",
      encryptedCredentials: "unused"
    });
    const deletedByWrongProject = await deleteImportSource(pool, `proj_${ulid()}`, source.id);
    expect(deletedByWrongProject).toBe(false);

    const deleted = await deleteImportSource(pool, projectId, source.id);
    expect(deleted).toBe(true);
  });
});
