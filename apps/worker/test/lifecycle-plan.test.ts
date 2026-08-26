import * as clickhouseModule from "@ironside/clickhouse";
import * as dbModule from "@ironside/db";
import type { ObjectStorage, StoredObject } from "@ironside/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLifecyclePlan } from "../src/retention/lifecycle-plan.js";

vi.mock("@ironside/db", async (importOriginal) => {
  const original = await importOriginal<typeof dbModule>();
  return {
    ...original,
    getProject: vi.fn(),
    listProjectsLimited: vi.fn(),
    summarizeMediaStorage: vi.fn()
  };
});

vi.mock("@ironside/clickhouse", async (importOriginal) => {
  const original = await importOriginal<typeof clickhouseModule>();
  return {
    ...original,
    summarizeIndexedLifecycleCandidates: vi.fn()
  };
});

const getProject = vi.mocked(dbModule.getProject);
const listProjectsLimited = vi.mocked(dbModule.listProjectsLimited);
const summarizeMediaStorage = vi.mocked(dbModule.summarizeMediaStorage);
const summarizeIndexedLifecycleCandidates = vi.mocked(
  clickhouseModule.summarizeIndexedLifecycleCandidates
);

function object(key: string, sizeBytes = 100): StoredObject {
  return { key, sizeBytes, lastModified: new Date("2026-01-02T00:00:00.000Z") };
}

function fakeStorage(objectsByPrefix: Record<string, StoredObject[]>): ObjectStorage {
  return {
    async *listObjects(prefix: string) {
      for (const entry of objectsByPrefix[prefix] ?? []) yield entry;
    }
  } as unknown as ObjectStorage;
}

beforeEach(() => {
  vi.clearAllMocks();
  listProjectsLimited.mockResolvedValue([
    {
      id: "proj.a+1",
      organizationId: "org_1",
      name: "Primary",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      rateLimitPerMinute: null,
      retentionDays: null,
      traceQuietPeriodSeconds: null
    }
  ]);
  getProject.mockResolvedValue(null);
  summarizeMediaStorage.mockResolvedValue([
    {
      projectId: "proj.a+1",
      assetCount: 2,
      sizeBytes: 900,
      oldestCreatedAt: "2025-01-01T00:00:00.000Z"
    }
  ]);
  summarizeIndexedLifecycleCandidates.mockResolvedValue([
    {
      projectId: "proj.a+1",
      traces: 3,
      observations: 5,
      scores: 1,
      rawEventRefs: 4
    }
  ]);
});

describe("createLifecyclePlan", () => {
  it("classifies only complete pre-cutoff days and protects pending raw batches", async () => {
    const storage = fakeStorage({
      "pending-ingest/": [
        object("pending-ingest/.internal/cursor.json", 10),
        object("pending-ingest/old-pending.json", 20)
      ],
      "failed-ingest/": [object("failed-ingest/old-eligible.json", 30)],
      "raw/proj.a+1/": [
        object("raw/proj.a+1/2026/01/01/old-pending.json", 110),
        object("raw/proj.a+1/2026/05/22/old-eligible.json", 120),
        // The cutoff is 2026-05-23T00:00:00Z. The entire cutoff day stays protected.
        object("raw/proj.a+1/2026/05/23/on-cutoff-day.json", 130),
        object("raw/proj.a+1/2026/06/01/recent.json", 140)
      ]
    });

    const plan = await createLifecyclePlan({
      pool: {} as never,
      clickhouse: {} as never,
      storage,
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z"),
      scanLimit: 100
    });

    expect(plan).toMatchObject({
      version: 1,
      mode: "dry-run",
      destructiveActionsEnabled: false,
      projectInventory: {
        registeredProjectCount: 1,
        includedProjectCount: 1,
        selectedProjectId: null,
        scanComplete: true
      },
      recovery: {
        pendingIntents: { objectCount: 1, sizeBytes: 20, scanComplete: true },
        failedDiagnostics: { objectCount: 1, sizeBytes: 30, scanComplete: true },
        pendingObjectsProtectedFromRetention: true
      }
    });
    expect(plan.projects[0]).toMatchObject({
      projectId: "proj.a+1",
      effectiveRetentionDays: 90,
      cutoff: "2026-05-23T00:00:00.000Z",
      indexedCandidates: { traces: 3, observations: 5, scores: 1, rawEventRefs: 4 },
      rawArchive: {
        examinedObjects: 4,
        candidateScanComplete: true,
        expiredCandidates: { objectCount: 2, sizeBytes: 230, scanComplete: true },
        protectedByPending: { objectCount: 1, sizeBytes: 110, scanComplete: true },
        scanCoverageComplete: true,
        expiredWithoutPendingMarker: { objectCount: 1, sizeBytes: 120, scanComplete: true },
        withFailedDiagnostic: { objectCount: 1, sizeBytes: 120, scanComplete: true },
        deletionEligible: false
      },
      media: {
        registeredAssetCount: 2,
        registeredSizeBytes: 900,
        deletionEligible: false
      }
    });
    expect(plan.projects[0]?.media.blockedReason).toContain("reference ledger");
  });

  it("keeps pending-marker absence incomplete when the pending inventory is truncated", async () => {
    const storage = fakeStorage({
      "pending-ingest/": [
        object("pending-ingest/one.json"),
        object("pending-ingest/two.json")
      ],
      "failed-ingest/": [],
      "raw/proj.a+1/": [object("raw/proj.a+1/2025/01/01/old.json")]
    });

    const plan = await createLifecyclePlan({
      pool: {} as never,
      clickhouse: {} as never,
      storage,
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z"),
      scanLimit: 1
    });

    expect(plan.recovery.pendingIntents.scanComplete).toBe(false);
    expect(plan.projects[0]?.rawArchive).toMatchObject({
      scanCoverageComplete: false,
      expiredWithoutPendingMarker: { objectCount: 1, scanComplete: false },
      deletionEligible: false
    });
  });

  it("marks the raw candidate scan incomplete when its cap is exhausted", async () => {
    const storage = fakeStorage({
      "pending-ingest/": [],
      "failed-ingest/": [],
      "raw/proj.a+1/": [
        object("raw/proj.a+1/2025/01/01/one.json"),
        object("raw/proj.a+1/2025/01/02/two.json")
      ]
    });

    const plan = await createLifecyclePlan({
      pool: {} as never,
      clickhouse: {} as never,
      storage,
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z"),
      scanLimit: 1
    });

    expect(plan.projects[0]?.rawArchive).toMatchObject({
      examinedObjects: 1,
      candidateScanComplete: false,
      scanCoverageComplete: false,
      expiredCandidates: { objectCount: 1, scanComplete: false },
      expiredWithoutPendingMarker: { objectCount: 1, scanComplete: false },
      deletionEligible: false
    });
  });

  it("does not rely on object-store iteration order when finding old raw batches", async () => {
    const storage = fakeStorage({
      "pending-ingest/": [],
      "failed-ingest/": [],
      "raw/proj.a+1/": [
        object("raw/proj.a+1/2026/07/01/recent-first.json"),
        object("raw/proj.a+1/2025/01/01/old-second.json")
      ]
    });

    const plan = await createLifecyclePlan({
      pool: {} as never,
      clickhouse: {} as never,
      storage,
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z"),
      scanLimit: 10
    });

    expect(plan.projects[0]?.rawArchive).toMatchObject({
      examinedObjects: 2,
      candidateScanComplete: true,
      expiredCandidates: { objectCount: 1, scanComplete: true }
    });
  });

  it("caps projects and shares one raw-object budget across them", async () => {
    const firstProject = {
      id: "proj.a+1",
      organizationId: "org_1",
      name: "First",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      rateLimitPerMinute: null,
      retentionDays: null,
      traceQuietPeriodSeconds: null
    };
    const secondProject = {
      id: "proj_second",
      organizationId: "org_1",
      name: "Second",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      rateLimitPerMinute: null,
      retentionDays: null,
      traceQuietPeriodSeconds: null
    };
    listProjectsLimited.mockResolvedValue([
      firstProject,
      secondProject
    ]);
    const storage = fakeStorage({
      "pending-ingest/": [],
      "failed-ingest/": [],
      "raw/proj.a+1/": [object("raw/proj.a+1/2025/01/01/one.json")],
      "raw/proj_second/": [object("raw/proj_second/2025/01/01/two.json")]
    });

    const limited = await createLifecyclePlan({
      pool: {} as never,
      clickhouse: {} as never,
      storage,
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z"),
      scanLimit: 1,
      projectLimit: 1
    });
    expect(limited.projectInventory).toMatchObject({
      registeredProjectCount: null,
      includedProjectCount: 1,
      scanComplete: false
    });
    expect(listProjectsLimited).toHaveBeenCalledWith(expect.anything(), 2);
    expect(limited.projects.map((project) => project.projectId)).toEqual(["proj.a+1"]);

    summarizeIndexedLifecycleCandidates.mockResolvedValueOnce([
      { projectId: "proj.a+1", traces: 0, observations: 0, scores: 0, rawEventRefs: 0 },
      { projectId: "proj_second", traces: 0, observations: 0, scores: 0, rawEventRefs: 0 }
    ]);
    const sharedBudget = await createLifecyclePlan({
      pool: {} as never,
      clickhouse: {} as never,
      storage,
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z"),
      scanLimit: 1,
      projectLimit: 2
    });
    expect(sharedBudget.projects[0]?.rawArchive).toMatchObject({
      examinedObjects: 1,
      candidateScanComplete: true
    });
    expect(sharedBudget.projects[1]?.rawArchive).toMatchObject({
      examinedObjects: 0,
      candidateScanComplete: false
    });

    getProject.mockResolvedValueOnce(secondProject);
    summarizeIndexedLifecycleCandidates.mockResolvedValueOnce([]);
    const selected = await createLifecyclePlan({
      pool: {} as never,
      clickhouse: {} as never,
      storage,
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z"),
      scanLimit: 1,
      projectLimit: 1,
      projectId: "proj_second"
    });
    expect(selected.projectInventory).toMatchObject({
      registeredProjectCount: null,
      includedProjectCount: 1,
      selectedProjectId: "proj_second",
      scanComplete: true
    });
    expect(getProject).toHaveBeenCalledWith(expect.anything(), "proj_second");
    expect(selected.projects[0]?.projectId).toBe("proj_second");
  });

  it("fails indexed counts closed when ClickHouse exceeds planner limits", async () => {
    summarizeIndexedLifecycleCandidates.mockRejectedValueOnce(new Error("limit exceeded"));
    const plan = await createLifecyclePlan({
      pool: {} as never,
      clickhouse: {} as never,
      storage: fakeStorage({
        "pending-ingest/": [],
        "failed-ingest/": [],
        "raw/proj.a+1/": []
      }),
      defaultRetentionDays: 90
    });

    expect(plan.projects[0]?.indexedCandidates).toEqual({
      scanComplete: false,
      traces: null,
      observations: null,
      scores: null,
      rawEventRefs: null,
      incompleteReason: "ClickHouse inventory exceeded its read limits or was unavailable."
    });
  });

  it("rejects invalid policy and scan bounds", async () => {
    await expect(createLifecyclePlan({
      pool: {} as never,
      clickhouse: {} as never,
      storage: fakeStorage({}),
      defaultRetentionDays: 0
    })).rejects.toThrow("defaultRetentionDays must be a positive safe integer");

    await expect(createLifecyclePlan({
      pool: {} as never,
      clickhouse: {} as never,
      storage: fakeStorage({}),
      defaultRetentionDays: 90,
      scanLimit: Number.NaN
    })).rejects.toThrow("scanLimit must be a positive safe integer");

    await expect(createLifecyclePlan({
      pool: {} as never,
      clickhouse: {} as never,
      storage: fakeStorage({}),
      defaultRetentionDays: 90,
      projectLimit: 0
    })).rejects.toThrow("projectLimit must be a positive safe integer");
  });
});
