import type { Pool } from "pg";

export interface MediaAsset {
  id: string;
  projectId: string;
  sha256: string;
  contentType: string;
  sizeBytes: number;
  objectKey: string;
  createdAt: string;
}

export interface ProjectMediaStorageSummary {
  projectId: string;
  assetCount: number;
  sizeBytes: number;
  oldestCreatedAt: string | null;
}

interface MediaAssetRow {
  id: string;
  project_id: string;
  sha256: string;
  content_type: string;
  size_bytes: string | number;
  object_key: string;
  created_at: Date;
}

function toAsset(row: MediaAssetRow): MediaAsset {
  return {
    id: row.id,
    projectId: row.project_id,
    sha256: row.sha256,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    objectKey: row.object_key,
    createdAt: row.created_at.toISOString()
  };
}

/**
 * Inserts a media asset, deduplicating on (project_id, sha256): uploading
 * the same bytes twice returns the EXISTING asset (original id, original
 * object key) rather than creating a second row. The no-op `DO UPDATE SET
 * sha256 = excluded.sha256` is what makes `RETURNING` yield the existing
 * row on conflict — plain `DO NOTHING` returns nothing.
 */
export async function createMediaAsset(
  pool: Pool,
  asset: Omit<MediaAsset, "createdAt">
): Promise<MediaAsset> {
  const result = await pool.query<MediaAssetRow>(
    `insert into media_assets (id, project_id, sha256, content_type, size_bytes, object_key)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (project_id, sha256) do update set sha256 = excluded.sha256
     returning id, project_id, sha256, content_type, size_bytes, object_key, created_at`,
    [asset.id, asset.projectId, asset.sha256, asset.contentType, asset.sizeBytes, asset.objectKey]
  );
  return toAsset(result.rows[0]!);
}

/** Looks up an asset by content hash — the dedup check that keeps stored objects genuinely immutable (a re-upload must not rewrite the object or its metadata). */
export async function getMediaAssetBySha(
  pool: Pool,
  projectId: string,
  sha256: string
): Promise<MediaAsset | null> {
  const result = await pool.query<MediaAssetRow>(
    `select id, project_id, sha256, content_type, size_bytes, object_key, created_at
     from media_assets where project_id = $1 and sha256 = $2`,
    [projectId, sha256]
  );
  return result.rows[0] ? toAsset(result.rows[0]) : null;
}

/** Fetches a media asset scoped to a project — a key can never read another project's media. */
export async function getMediaAsset(
  pool: Pool,
  projectId: string,
  id: string
): Promise<MediaAsset | null> {
  const result = await pool.query<MediaAssetRow>(
    `select id, project_id, sha256, content_type, size_bytes, object_key, created_at
     from media_assets where project_id = $1 and id = $2`,
    [projectId, id]
  );
  return result.rows[0] ? toAsset(result.rows[0]) : null;
}

/** Read-only storage inventory. It deliberately does not classify media as
 * retention-eligible: without a trace-to-asset reference ledger, age alone
 * cannot prove that a content-addressed blob is unreachable. */
export async function summarizeMediaStorage(
  pool: Pool,
  projectIds: string[]
): Promise<ProjectMediaStorageSummary[]> {
  if (projectIds.length === 0) return [];
  const result = await pool.query<{
    project_id: string;
    asset_count: string | number;
    size_bytes: string | number;
    oldest_created_at: Date | null;
  }>(
    `select project_id,
            count(*) as asset_count,
            coalesce(sum(size_bytes), 0) as size_bytes,
            min(created_at) as oldest_created_at
       from media_assets
      where project_id = any($1::text[])
      group by project_id
      order by project_id asc`,
    [projectIds]
  );
  return result.rows.map((row) => ({
    projectId: row.project_id,
    assetCount: Number(row.asset_count),
    sizeBytes: Number(row.size_bytes),
    oldestCreatedAt: row.oldest_created_at?.toISOString() ?? null
  }));
}
