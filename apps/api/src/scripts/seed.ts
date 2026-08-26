// Local-dev seed: creates an org, a project, and an Ingest credential,
// printing the token once (only its hash is stored).
//
// Usage: pnpm --filter @ironside/api seed
import { createProject, runMigrations } from "@ironside/db";
import { Pool } from "pg";
import { ulid } from "ulid";
import { createMachineCredential } from "../lib/machine-credentials.js";
import { loadConfig } from "../config.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });

try {
  await runMigrations(pool);

  const owners = await pool.query<{ organization_id: string }>(
    "select organization_id from owner_principals limit 1"
  );
  const orgId = owners.rows[0]?.organization_id;
  if (!orgId) {
    throw new Error(
      "complete owner setup before seeding a local project"
    );
  }

  const existingProject = await pool.query<{ id: string }>(
    "select id from projects where organization_id = $1 order by created_at asc, id asc limit 1",
    [orgId]
  );
  let projectId = existingProject.rows[0]?.id;
  if (!projectId) {
    projectId = `proj_${ulid()}`;
    await createProject(pool, { id: projectId, organizationId: orgId, name: "default" });
  }
  const credential = await createMachineCredential(pool, {
    projectId,
    organizationId: orgId,
    name: "local-dev ingest",
    preset: "ingest",
    expiresAt: null,
    actor: { principalId: null, username: "host seed" }
  });

  console.log(`organization: ${orgId}`);
  console.log(`project:      ${projectId}`);
  console.log(`credential: ${credential.token}`);
} finally {
  await pool.end();
}
