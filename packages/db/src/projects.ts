import type { Pool } from "pg";

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  createdAt: Date;
  /** Per-project override of the platform-default ingest rate limit; null = use the default. */
  rateLimitPerMinute: number | null;
  /** Per-project override of the platform-default ClickHouse retention window in days; null = use the default. */
  retentionDays: number | null;
  /** Per-project override of the trace completion quiet period; null = use the default. */
  traceQuietPeriodSeconds: number | null;
}

interface ProjectRow {
  id: string;
  organization_id: string;
  name: string;
  created_at: Date;
  rate_limit_per_minute: number | null;
  retention_days: number | null;
  trace_quiet_period_seconds: number | null;
}

function fromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    createdAt: row.created_at,
    rateLimitPerMinute: row.rate_limit_per_minute,
    retentionDays: row.retention_days,
    traceQuietPeriodSeconds: row.trace_quiet_period_seconds
  };
}

export async function getProject(pool: Pool, id: string): Promise<Project | null> {
  const result = await pool.query<ProjectRow>("select * from projects where id = $1", [id]);
  const row = result.rows[0];
  return row ? fromRow(row) : null;
}

export async function listAllProjects(pool: Pool): Promise<Project[]> {
  const result = await pool.query<ProjectRow>("select * from projects order by created_at asc");
  return result.rows.map(fromRow);
}

/** Bounded project registry read. Callers commonly request limit + 1 and use
 * the sentinel row to report whether their view is complete. */
export async function listProjectsLimited(pool: Pool, limit: number): Promise<Project[]> {
  const result = await pool.query<ProjectRow>(
    "select * from projects order by created_at asc, id asc limit $1",
    [limit]
  );
  return result.rows.map(fromRow);
}

export async function listProjectsForOrganization(
  pool: Pool,
  organizationId: string
): Promise<Project[]> {
  const result = await pool.query<ProjectRow>(
    "select * from projects where organization_id = $1 order by created_at asc",
    [organizationId]
  );
  return result.rows.map(fromRow);
}

export interface CreateProjectInput {
  id: string;
  organizationId: string;
  name: string;
}

export async function createProject(pool: Pool, input: CreateProjectInput): Promise<Project> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<ProjectRow>(
      "insert into projects (id, organization_id, name) values ($1, $2, $3) returning *",
      [input.id, input.organizationId, input.name]
    );
    await client.query(
      "insert into project_environment_registry_state (project_id) values ($1)",
      [input.id]
    );
    const row = result.rows[0];
    if (!row) throw new Error("failed to create project");
    await client.query("commit");
    return fromRow(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export interface ProjectQuotas {
  /** undefined = leave unchanged; null = clear the override back to the platform default. */
  rateLimitPerMinute?: number | null;
  retentionDays?: number | null;
  traceQuietPeriodSeconds?: number | null;
}

// COALESCE($n, existing_column) can't distinguish "explicitly clear to
// null" from "field not provided" — both arrive as SQL NULL through
// parameter binding. Each field is only included in the UPDATE's SET
// clause (as its own $n placeholder) when the caller actually provided
// it, so an omitted field's column is untouched and a provided `null`
// really does clear the override.
export async function setProjectQuotas(
  pool: Pool,
  id: string,
  quotas: ProjectQuotas
): Promise<Project | null> {
  const assignments: string[] = [];
  const values: unknown[] = [id];

  if ("rateLimitPerMinute" in quotas) {
    values.push(quotas.rateLimitPerMinute);
    assignments.push(`rate_limit_per_minute = $${values.length}`);
  }
  if ("retentionDays" in quotas) {
    values.push(quotas.retentionDays);
    assignments.push(`retention_days = $${values.length}`);
  }
  if ("traceQuietPeriodSeconds" in quotas) {
    values.push(quotas.traceQuietPeriodSeconds);
    assignments.push(`trace_quiet_period_seconds = $${values.length}`);
  }

  if (assignments.length === 0) {
    return getProject(pool, id);
  }

  const result = await pool.query<ProjectRow>(
    `update projects set ${assignments.join(", ")}, updated_at = now() where id = $1 returning *`,
    values
  );
  const row = result.rows[0];
  return row ? fromRow(row) : null;
}
