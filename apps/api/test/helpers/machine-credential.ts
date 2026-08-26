import type { MachineCredentialPreset } from "@ironside/shared";
import type { Pool } from "pg";
import { createMachineCredential } from "../../src/lib/machine-credentials.js";

export async function createTestMachineCredential(
  pool: Pool,
  projectId: string,
  name: string,
  preset: MachineCredentialPreset
) {
  const project = await pool.query<{ organization_id: string }>(
    "select organization_id from projects where id = $1",
    [projectId]
  );
  const organizationId = project.rows[0]?.organization_id;
  if (!organizationId) throw new Error(`test project ${projectId} does not exist`);
  return createMachineCredential(pool, {
    projectId,
    organizationId,
    name,
    preset,
    expiresAt: null,
    actor: { principalId: null, username: "api test" }
  });
}
