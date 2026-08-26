import type { ClickHouseClient } from "@clickhouse/client";

export interface ProjectLifecyclePolicy {
  projectId: string;
  cutoff: Date;
}

export interface IndexedLifecycleCandidates {
  projectId: string;
  traces: number;
  observations: number;
  scores: number;
  rawEventRefs: number;
}

type CandidateField = "traces" | "observations" | "scores" | "rawEventRefs";

const RETAINED_TABLES: readonly {
  table: "traces" | "observations" | "scores";
  timestampColumn: "timestamp" | "start_time";
  field: Exclude<CandidateField, "rawEventRefs">;
}[] = [
  { table: "traces", timestampColumn: "timestamp", field: "traces" },
  { table: "observations", timestampColumn: "start_time", field: "observations" },
  { table: "scores", timestampColumn: "timestamp", field: "scores" }
];

/**
 * Counts query-visible rows older than each project's effective cutoff.
 * This is inventory only: it performs no mutation and makes no physical-byte
 * reclamation claim. The fixed table/column allowlist keeps identifiers out
 * of caller control.
 */
export async function summarizeIndexedLifecycleCandidates(
  client: ClickHouseClient,
  policies: ProjectLifecyclePolicy[]
): Promise<IndexedLifecycleCandidates[]> {
  if (policies.length === 0) return [];

  const byProject = new Map<string, IndexedLifecycleCandidates>();
  for (const policy of policies) {
    byProject.set(policy.projectId, {
      projectId: policy.projectId,
      traces: 0,
      observations: 0,
      scores: 0,
      rawEventRefs: 0
    });
  }

  const projectIds = policies.map((policy) => policy.projectId);
  const cutoffs = policies.map((policy) => toClickHouseDateTime64(policy.cutoff));
  const latestCutoff = toClickHouseDateTime64(
    new Date(Math.max(...policies.map((policy) => policy.cutoff.getTime())))
  );
  const queryParams = { projectIds, cutoffs, latestCutoff };
  const clickhouse_settings = {
    max_execution_time: 30,
    max_threads: 2,
    max_memory_usage: String(512 * 1024 * 1024),
    max_rows_to_read: "50000000",
    read_overflow_mode: "throw" as const
  };

  for (const retained of RETAINED_TABLES) {
    const result = await client.query({
      query: `
        with mapFromArrays(
          {projectIds:Array(String)},
          {cutoffs:Array(DateTime64(3, 'UTC'))}
        ) as project_cutoffs
        select project_id, count() as candidate_count
        from ${retained.table} final
        where mapContains(project_cutoffs, project_id)
          and is_deleted = 0
          and ${retained.timestampColumn} < {latestCutoff:DateTime64(3, 'UTC')}
          and ${retained.timestampColumn} < project_cutoffs[project_id]
        group by project_id
      `,
      query_params: queryParams,
      clickhouse_settings,
      format: "JSONEachRow"
    });
    const rows = await result.json<{ project_id: string; candidate_count: string | number }>();
    for (const row of rows) {
      const summary = byProject.get(row.project_id);
      if (summary) summary[retained.field] = Number(row.candidate_count);
    }
  }

  const refsResult = await client.query({
    query: `
      with mapFromArrays(
        {projectIds:Array(String)},
        {cutoffs:Array(DateTime64(3, 'UTC'))}
      ) as project_cutoffs
      select project_id, count() as candidate_count
      from raw_event_refs final
      where mapContains(project_cutoffs, project_id)
        and applied = 1
        and received_at < {latestCutoff:DateTime64(3, 'UTC')}
        and received_at < project_cutoffs[project_id]
      group by project_id
    `,
    query_params: queryParams,
    clickhouse_settings,
    format: "JSONEachRow"
  });
  const refRows = await refsResult.json<{ project_id: string; candidate_count: string | number }>();
  for (const row of refRows) {
    const summary = byProject.get(row.project_id);
    if (summary) summary.rawEventRefs = Number(row.candidate_count);
  }

  return [...byProject.values()];
}

function toClickHouseDateTime64(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}
