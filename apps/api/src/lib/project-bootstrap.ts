import type { Pool } from "pg";
import { ulid } from "ulid";
import type { Project } from "@ironside/db";
import { insertMachineCredential, type CreatedMachineCredentialRow } from "./machine-credentials.js";

interface ProjectRow {
  id: string;
  organization_id: string;
  name: string;
  created_at: Date;
  rate_limit_per_minute: number | null;
  retention_days: number | null;
  trace_quiet_period_seconds: number | null;
}

export interface CreatedProjectWithCredential {
  project: Project;
  initialCredential: CreatedMachineCredentialRow;
}

/** Creates a project and its first one-time-disclosed Ingest credential atomically. */
export async function createProjectWithBootstrapCredential(
  pool: Pool,
  input: { organizationId: string; name: string; principalId: string; username: string }
): Promise<CreatedProjectWithCredential> {
  const client = await pool.connect();
  const projectId = `proj_${ulid()}`;

  try {
    await client.query("begin");
    const projectResult = await client.query<ProjectRow>(
      `insert into projects (id, organization_id, name)
       values ($1, $2, $3)
       returning id, organization_id, name, created_at,
                 rate_limit_per_minute, retention_days, trace_quiet_period_seconds`,
      [projectId, input.organizationId, input.name]
    );
    await client.query(
      "insert into project_environment_registry_state (project_id) values ($1)",
      [projectId]
    );
    const credential = await insertMachineCredential(client, {
      projectId,
      organizationId: input.organizationId,
      name: "Initial ingest credential",
      preset: "ingest",
      expiresAt: null,
      actor: { principalId: input.principalId, username: input.username }
    });
    const projectRow = projectResult.rows[0];
    if (!projectRow) throw new Error("failed to create project bootstrap credential");
    await client.query("commit");

    return {
      project: {
        id: projectRow.id,
        organizationId: projectRow.organization_id,
        name: projectRow.name,
        createdAt: projectRow.created_at,
        rateLimitPerMinute: projectRow.rate_limit_per_minute,
        retentionDays: projectRow.retention_days,
        traceQuietPeriodSeconds: projectRow.trace_quiet_period_seconds
      },
      initialCredential: credential
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
