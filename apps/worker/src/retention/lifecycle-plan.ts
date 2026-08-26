import {
  summarizeIndexedLifecycleCandidates,
  type ClickHouseClient,
  type IndexedLifecycleCandidates
} from "@ironside/clickhouse";
import {
  getProject,
  listProjectsLimited,
  summarizeMediaStorage,
  type ProjectMediaStorageSummary
} from "@ironside/db";
import {
  PENDING_INGEST_INTERNAL_PREFIX,
  PENDING_INGEST_PREFIX,
  FAILED_INGEST_PREFIX,
  pendingIngestObjectKeyForRaw
} from "@ironside/shared";
import type { ObjectStorage, StoredObject } from "@ironside/storage";
import type { Pool } from "pg";

const PLAN_VERSION = 1;

export interface LifecyclePlanOptions {
  pool: Pool;
  clickhouse: ClickHouseClient;
  storage: ObjectStorage;
  defaultRetentionDays: number;
  /** Per pending/failed prefix cap and shared raw-object cap across projects. */
  scanLimit?: number;
  /** Maximum projects included unless one exact project is selected. */
  projectLimit?: number;
  /** Optional exact project scope for large installations. */
  projectId?: string;
  now?: Date;
}

export interface ObjectInventory {
  objectCount: number;
  sizeBytes: number;
  oldestLastModified: string | null;
  scanComplete: boolean;
}

export interface ProjectLifecyclePlan {
  projectId: string;
  projectName: string;
  effectiveRetentionDays: number;
  cutoff: string;
  indexedCandidates: {
    scanComplete: boolean;
    traces: number | null;
    observations: number | null;
    scores: number | null;
    rawEventRefs: number | null;
    incompleteReason: string | null;
  };
  rawArchive: {
    examinedObjects: number;
    candidateScanComplete: boolean;
    expiredCandidates: ObjectInventory;
    protectedByPending: ObjectInventory;
    scanCoverageComplete: boolean;
    expiredWithoutPendingMarker: ObjectInventory;
    withFailedDiagnostic: ObjectInventory;
    deletionEligible: false;
    blockedReason: string;
  };
  media: {
    registeredAssetCount: number;
    registeredSizeBytes: number;
    oldestCreatedAt: string | null;
    deletionEligible: false;
    blockedReason: string;
  };
}

export interface LifecyclePlan {
  version: typeof PLAN_VERSION;
  mode: "dry-run";
  destructiveActionsEnabled: false;
  generatedAt: string;
  defaultRetentionDays: number;
  recoveryPrefixScanLimit: number;
  rawScanLimitAcrossProjects: number;
  projectLimit: number;
  projectInventory: {
    registeredProjectCount: number | null;
    includedProjectCount: number;
    selectedProjectId: string | null;
    scanComplete: boolean;
  };
  projects: ProjectLifecyclePlan[];
  recovery: {
    pendingIntents: ObjectInventory;
    failedDiagnostics: ObjectInventory;
    pendingObjectsProtectedFromRetention: true;
  };
  exclusions: string[];
}

const INCOMPLETE_INDEXED: ProjectLifecyclePlan["indexedCandidates"] = {
  scanComplete: false,
  traces: null,
  observations: null,
  scores: null,
  rawEventRefs: null,
  incompleteReason: "ClickHouse inventory exceeded its read limits or was unavailable."
};

const MEDIA_BLOCK_REASON =
  "No authoritative trace-to-media reference ledger exists; upload age cannot prove a shared blob is unreachable.";

/**
 * Produces a bounded, read-only lifecycle manifest. It is intentionally not
 * scheduled: operators run it to size and verify policy before a later batch
 * enables any object deletion.
 */
export async function createLifecyclePlan(
  options: LifecyclePlanOptions
): Promise<LifecyclePlan> {
  const now = options.now ?? new Date();
  const scanLimit = options.scanLimit ?? 100_000;
  const projectLimit = options.projectLimit ?? 1_000;
  assertPositiveInteger("defaultRetentionDays", options.defaultRetentionDays);
  assertPositiveInteger("scanLimit", scanLimit);
  assertPositiveInteger("projectLimit", projectLimit);

  const projectSelection = options.projectId
    ? await getProject(options.pool, options.projectId).then((project) => ({
        projects: project ? [project] : [],
        registeredProjectCount: null,
        scanComplete: true
      }))
    : await listProjectsLimited(options.pool, projectLimit + 1).then((projects) => ({
        projects: projects.slice(0, projectLimit),
        registeredProjectCount: projects.length <= projectLimit ? projects.length : null,
        scanComplete: projects.length <= projectLimit
      }));
  if (options.projectId && projectSelection.projects.length === 0) {
    throw new Error(`project ${options.projectId} does not exist`);
  }
  const projects = projectSelection.projects;
  const projectPolicies = projects.map((project) => {
    const effectiveRetentionDays = project.retentionDays ?? options.defaultRetentionDays;
    assertPositiveInteger(`retentionDays for project ${project.id}`, effectiveRetentionDays);
    return {
      project,
      effectiveRetentionDays,
      cutoff: subtractDays(now, effectiveRetentionDays)
    };
  });

  const [indexedResult, media, pendingScan, failedScan] = await Promise.all([
    summarizeIndexedLifecycleCandidates(
      options.clickhouse,
      projectPolicies.map((policy) => ({
        projectId: policy.project.id,
        cutoff: policy.cutoff
      }))
    ).then((entries) => ({ scanComplete: true as const, entries })).catch(() => ({
      scanComplete: false as const,
      entries: [] as IndexedLifecycleCandidates[]
    })),
    summarizeMediaStorage(options.pool, projects.map((project) => project.id)),
    scanPrefix(options.storage, PENDING_INGEST_PREFIX, scanLimit, (object) =>
      object.key.startsWith(PENDING_INGEST_INTERNAL_PREFIX) ? "ignore" : "include"
    ),
    scanPrefix(options.storage, FAILED_INGEST_PREFIX, scanLimit)
  ]);

  const indexedByProject = new Map(indexedResult.entries.map((entry) => [entry.projectId, entry]));
  const mediaByProject = new Map(media.map((entry) => [entry.projectId, entry]));
  const pendingKeys = new Set(pendingScan.includedObjects.map((object) => object.key));
  const failedKeys = new Set(failedScan.includedObjects.map((object) => object.key));

  const projectPlans: ProjectLifecyclePlan[] = [];
  let rawScanBudgetRemaining = scanLimit;
  for (const policy of projectPolicies) {
    const raw = await scanExpiredRawObjects(
      options.storage,
      policy.project.id,
      policy.cutoff,
      rawScanBudgetRemaining
    );
    rawScanBudgetRemaining -= raw.examinedObjects;
    const protectedObjects: StoredObject[] = [];
    const withoutPendingObjects: StoredObject[] = [];
    const failedDiagnosticObjects: StoredObject[] = [];
    const scanCoverageComplete = pendingScan.inventory.scanComplete &&
      failedScan.inventory.scanComplete && raw.candidateScanComplete;
    for (const object of raw.expiredObjects) {
      let pendingKey: string;
      try {
        pendingKey = pendingIngestObjectKeyForRaw(object.key);
      } catch {
        // Non-canonical raw keys are never classified as deletion-eligible.
        continue;
      }
      if (pendingKeys.has(pendingKey)) protectedObjects.push(object);
      else withoutPendingObjects.push(object);
      const failedKey = `${FAILED_INGEST_PREFIX}${pendingKey.slice(PENDING_INGEST_PREFIX.length)}`;
      if (failedKeys.has(failedKey)) failedDiagnosticObjects.push(object);
    }

    const indexedEntry = indexedByProject.get(policy.project.id);
    const mediaEntry = mediaByProject.get(policy.project.id);
    projectPlans.push({
      projectId: policy.project.id,
      projectName: policy.project.name,
      effectiveRetentionDays: policy.effectiveRetentionDays,
      cutoff: policy.cutoff.toISOString(),
      indexedCandidates: indexedResult.scanComplete && indexedEntry
        ? {
            scanComplete: true,
            traces: indexedEntry.traces,
            observations: indexedEntry.observations,
            scores: indexedEntry.scores,
            rawEventRefs: indexedEntry.rawEventRefs,
            incompleteReason: null
          }
        : { ...INCOMPLETE_INDEXED },
      rawArchive: {
        examinedObjects: raw.examinedObjects,
        candidateScanComplete: raw.candidateScanComplete,
        expiredCandidates: inventory(raw.expiredObjects, raw.candidateScanComplete),
        protectedByPending: inventory(
          protectedObjects,
          pendingScan.inventory.scanComplete && raw.candidateScanComplete
        ),
        scanCoverageComplete,
        expiredWithoutPendingMarker: inventory(
          withoutPendingObjects,
          pendingScan.inventory.scanComplete && raw.candidateScanComplete
        ),
        withFailedDiagnostic: inventory(
          failedDiagnosticObjects,
          failedScan.inventory.scanComplete && raw.candidateScanComplete
        ),
        deletionEligible: false,
        blockedReason: "This manifest is observational; a future executor must recheck references, diagnostics, coverage, and pending state at deletion time."
      },
      media: mediaPlan(mediaEntry)
    });
  }

  return {
    version: PLAN_VERSION,
    mode: "dry-run",
    destructiveActionsEnabled: false,
    generatedAt: now.toISOString(),
    defaultRetentionDays: options.defaultRetentionDays,
    recoveryPrefixScanLimit: scanLimit,
    rawScanLimitAcrossProjects: scanLimit,
    projectLimit,
    projectInventory: {
      registeredProjectCount: projectSelection.registeredProjectCount,
      includedProjectCount: projects.length,
      selectedProjectId: options.projectId ?? null,
      scanComplete: projectSelection.scanComplete
    },
    projects: projectPlans,
    recovery: {
      pendingIntents: pendingScan.inventory,
      failedDiagnostics: failedScan.inventory,
      pendingObjectsProtectedFromRetention: true
    },
    exclusions: [
      "Media deletion is blocked until retained traces have an authoritative media-reference ledger.",
      "Object-store versions, backups, exports, and WORM/Object Lock copies are outside this plan.",
      "Counts describe logical candidates; they do not promise immediate physical ClickHouse byte reclamation.",
      "Append-only raw coverage and retention-marker rows are not scanned or classified; exact-key intent preparation is a separate command.",
      "Raw objects belonging to deleted or otherwise unregistered projects are not inventoried.",
      "Media totals cover registered Postgres asset rows only; orphaned or missing object-store blobs are not reconciled.",
      "This command never deletes or mutates data."
    ]
  };
}

function mediaPlan(summary: ProjectMediaStorageSummary | undefined): ProjectLifecyclePlan["media"] {
  return {
    registeredAssetCount: summary?.assetCount ?? 0,
    registeredSizeBytes: summary?.sizeBytes ?? 0,
    oldestCreatedAt: summary?.oldestCreatedAt ?? null,
    deletionEligible: false,
    blockedReason: MEDIA_BLOCK_REASON
  };
}

async function scanExpiredRawObjects(
  storage: ObjectStorage,
  projectId: string,
  cutoff: Date,
  limit: number
): Promise<{
  expiredObjects: StoredObject[];
  examinedObjects: number;
  candidateScanComplete: boolean;
}> {
  const prefix = `raw/${projectId}/`;
  const cutoffDay = cutoff.toISOString().slice(0, 10);
  const expiredObjects: StoredObject[] = [];
  let examinedObjects = 0;

  if (limit === 0) {
    return { expiredObjects, examinedObjects, candidateScanComplete: false };
  }

  for await (const object of storage.listObjects(prefix)) {
    examinedObjects += 1;
    if (examinedObjects > limit) {
      return { expiredObjects, examinedObjects: limit, candidateScanComplete: false };
    }
    const day = rawObjectDay(projectId, object.key);
    if (day === null) continue;
    // A complete UTC day is the safety margin: objects on the cutoff day
    // remain protected even if their exact acceptance time is earlier.
    if (day < cutoffDay) expiredObjects.push(object);
  }

  return { expiredObjects, examinedObjects, candidateScanComplete: true };
}

function rawObjectDay(projectId: string, key: string): string | null {
  const escapedProjectId = projectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^raw/${escapedProjectId}/(\\d{4})/(\\d{2})/(\\d{2})/[^/]+\\.json$`
  ).exec(key);
  if (!match) return null;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day
    ? null
    : day;
}

async function scanPrefix(
  storage: ObjectStorage,
  prefix: string,
  limit: number,
  classify: (object: StoredObject) => "include" | "ignore" = () => "include"
): Promise<{ inventory: ObjectInventory; includedObjects: StoredObject[] }> {
  const includedObjects: StoredObject[] = [];
  let examined = 0;
  let scanComplete = true;
  for await (const object of storage.listObjects(prefix)) {
    examined += 1;
    if (examined > limit) {
      scanComplete = false;
      break;
    }
    if (classify(object) === "include") includedObjects.push(object);
  }
  return {
    inventory: inventory(includedObjects, scanComplete),
    includedObjects
  };
}

function inventory(objects: StoredObject[], scanComplete: boolean): ObjectInventory {
  let oldest: Date | undefined;
  let sizeBytes = 0;
  for (const object of objects) {
    sizeBytes += object.sizeBytes;
    if (object.lastModified && (!oldest || object.lastModified < oldest)) {
      oldest = object.lastModified;
    }
  }
  return {
    objectCount: objects.length,
    sizeBytes,
    oldestLastModified: oldest?.toISOString() ?? null,
    scanComplete
  };
}

function subtractDays(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}
