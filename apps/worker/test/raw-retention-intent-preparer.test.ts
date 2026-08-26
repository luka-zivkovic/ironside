import * as clickhouseModule from "@ironside/clickhouse";
import * as dbModule from "@ironside/db";
import { failedIngestObjectKey, type QueueMessage } from "@ironside/shared";
import type { ObjectStorage, StoredObject } from "@ironside/storage";
import type { Queue } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareRawRetentionIntents,
  RAW_RETENTION_FAILED_DIAGNOSTIC_MAX_BYTES,
  RAW_RETENTION_PREPARE_MAX_BYTES,
  RAW_RETENTION_PREPARE_MAX_OBJECTS
} from "../src/retention/raw-retention-intent-preparer.js";

vi.mock("@ironside/clickhouse", async (importOriginal) => {
  const original = await importOriginal<typeof clickhouseModule>();
  return {
    ...original,
    getRetentionVisibleTraceIds: vi.fn(),
    getRawObjectRefSnapshot: vi.fn()
  };
});

vi.mock("@ironside/db", async (importOriginal) => {
  const original = await importOriginal<typeof dbModule>();
  return {
    ...original,
    getProject: vi.fn(),
    inspectIngestFailuresForObject: vi.fn(),
    createRawRetentionIntents: vi.fn()
  };
});

const getRetentionVisibleTraceIds = vi.mocked(
  clickhouseModule.getRetentionVisibleTraceIds
);
const getRawObjectRefSnapshot = vi.mocked(clickhouseModule.getRawObjectRefSnapshot);
const getProject = vi.mocked(dbModule.getProject);
const inspectIngestFailuresForObject = vi.mocked(
  dbModule.inspectIngestFailuresForObject
);
const createRawRetentionIntents = vi.mocked(dbModule.createRawRetentionIntents);

const PROJECT_ID = "proj_1";
const OLD_KEY = `raw/${PROJECT_ID}/2025/01/01/batch_1.json`;

function missingObjectError(): Error {
  return Object.assign(new Error("missing"), {
    name: "NoSuchKey",
    $metadata: { httpStatusCode: 404 }
  });
}

function fakeStorage(options: {
  stats?: Record<string, StoredObject>;
  existing?: string[];
  json?: Record<string, unknown>;
} = {}) {
  const remove = vi.fn(async () => undefined);
  const storage = {
    stat: vi.fn(async (key: string) => {
      const explicit = options.stats?.[key];
      if (explicit) return explicit;
      if (Object.prototype.hasOwnProperty.call(options.json ?? {}, key)) {
        return { key, sizeBytes: Buffer.byteLength(JSON.stringify(options.json?.[key])) };
      }
      return null;
    }),
    exists: vi.fn(async (key: string) => options.existing?.includes(key) ?? false),
    getJson: vi.fn(async (key: string) => {
      if (Object.prototype.hasOwnProperty.call(options.json ?? {}, key)) {
        return options.json?.[key];
      }
      throw missingObjectError();
    }),
    delete: remove
  } as unknown as ObjectStorage;
  return { storage, remove };
}

function fakeQueue(states: Record<string, string> = {}): Queue<QueueMessage> {
  return {
    getJob: vi.fn(async (id: string) => {
      const state = states[id];
      return state ? { getState: async () => state } : undefined;
    })
  } as unknown as Queue<QueueMessage>;
}

function failedDiagnostic(overrides: Record<string, unknown> = {}) {
  return {
    batchId: "batch_1",
    projectId: PROJECT_ID,
    objectKey: OLD_KEY,
    eventCount: 1,
    intentCreatedAt: "2025-01-01T00:00:00.000Z",
    failedAt: "2025-01-01T01:00:00.000Z",
    attemptsMade: 5,
    reason: "exhausted retries",
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getProject.mockResolvedValue({
    id: PROJECT_ID,
    organizationId: "org_1",
    name: "Test",
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    rateLimitPerMinute: null,
    retentionDays: null,
    traceQuietPeriodSeconds: null
  });
  getRawObjectRefSnapshot.mockResolvedValue({
    refs: [{ traceId: "trace_1", applied: 1 }],
    truncated: false
  });
  getRetentionVisibleTraceIds.mockResolvedValue(new Set());
  inspectIngestFailuresForObject.mockResolvedValue({
    count: 0,
    newestCreatedAt: null,
    truncated: false
  });
  createRawRetentionIntents.mockImplementation(async (_pool, inputs) =>
    inputs.map((input) => ({
      ...input,
      state: "prepared" as const,
      attempts: 0,
      lastError: null,
      preparedAt: new Date("2026-08-21T00:00:00.000Z"),
      updatedAt: new Date("2026-08-21T00:00:00.000Z"),
      completedAt: null
    }))
  );
});

describe("prepareRawRetentionIntents", () => {
  it("prepares an applied object without invoking any delete surface", async () => {
    const { storage, remove } = fakeStorage({
      stats: { [OLD_KEY]: { key: OLD_KEY, sizeBytes: 123 } }
    });

    const result = await prepareRawRetentionIntents({
      pool: {} as never,
      clickhouse: {} as never,
      storage,
      queue: fakeQueue(),
      projectId: PROJECT_ID,
      objectKeys: [OLD_KEY],
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z"),
      preparationId: "rtp_test"
    });

    expect(result).toMatchObject({
      version: 1,
      mode: "prepare-only",
      destructiveActionsEnabled: false,
      prepared: [{ objectKey: OLD_KEY, classification: "applied" }],
      skipped: []
    });
    expect(createRawRetentionIntents).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          projectId: PROJECT_ID,
          objectKey: OLD_KEY,
          objectSizeBytes: 123,
          retentionCutoffDay: "2026-05-23",
          traceIds: ["trace_1"],
          classification: "applied"
        })
      ]
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps even validated terminal failures when no trace tombstone can prove deletion", async () => {
    const diagnosticKey = failedIngestObjectKey("batch_1");
    const { storage } = fakeStorage({
      stats: { [OLD_KEY]: { key: OLD_KEY, sizeBytes: 50 } },
      json: { [diagnosticKey]: failedDiagnostic() }
    });
    getRawObjectRefSnapshot.mockResolvedValue({ refs: [], truncated: false });

    const result = await prepareRawRetentionIntents({
      pool: {} as never,
      clickhouse: {} as never,
      storage,
      queue: fakeQueue(),
      projectId: PROJECT_ID,
      objectKeys: [OLD_KEY],
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z")
    });

    expect(result.prepared).toEqual([]);
    expect(result.skipped).toEqual([
      { objectKey: OLD_KEY, reason: "no_authoritative_trace_refs" }
    ]);
    expect(storage.getJson).toHaveBeenCalledWith(diagnosticKey, {
      maxBytes: RAW_RETENTION_FAILED_DIAGNOSTIC_MAX_BYTES
    });
  });

  it("vetoes pending markers, live queue states, and ambiguous ref-less objects", async () => {
    const second = `raw/${PROJECT_ID}/2025/01/02/batch_2.json`;
    const third = `raw/${PROJECT_ID}/2025/01/03/batch_3.json`;
    const { storage } = fakeStorage({
      stats: {
        [OLD_KEY]: { key: OLD_KEY, sizeBytes: 1 },
        [second]: { key: second, sizeBytes: 1 },
        [third]: { key: third, sizeBytes: 1 }
      },
      existing: ["pending-ingest/batch_1.json"]
    });
    getRawObjectRefSnapshot.mockResolvedValue({ refs: [], truncated: false });

    const result = await prepareRawRetentionIntents({
      pool: {} as never,
      clickhouse: {} as never,
      storage,
      queue: fakeQueue({ batch_2: "active" }),
      projectId: PROJECT_ID,
      objectKeys: [OLD_KEY, second, third],
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z")
    });

    expect(result.prepared).toEqual([]);
    expect(result.skipped).toEqual([
      { objectKey: OLD_KEY, reason: "pending_ingest" },
      { objectKey: second, reason: "queue_not_terminal" },
      { objectKey: third, reason: "no_authoritative_trace_refs" }
    ]);
  });

  it("vetoes malformed or cross-project terminal diagnostics", async () => {
    const diagnosticKey = failedIngestObjectKey("batch_1");
    const { storage } = fakeStorage({
      stats: { [OLD_KEY]: { key: OLD_KEY, sizeBytes: 1 } },
      json: { [diagnosticKey]: failedDiagnostic({ projectId: "proj_other" }) }
    });

    const result = await prepareRawRetentionIntents({
      pool: {} as never,
      clickhouse: {} as never,
      storage,
      queue: fakeQueue({ batch_1: "failed" }),
      projectId: PROJECT_ID,
      objectKeys: [OLD_KEY],
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z")
    });

    expect(result.skipped).toEqual([
      { objectKey: OLD_KEY, reason: "failed_diagnostic_invalid" }
    ]);
    expect(createRawRetentionIntents).toHaveBeenCalledWith(expect.anything(), []);
  });

  it("vetoes newly failed and oversized terminal sidecars before reading refs", async () => {
    const diagnosticKey = failedIngestObjectKey("batch_1");
    const recent = fakeStorage({
      stats: { [OLD_KEY]: { key: OLD_KEY, sizeBytes: 1 } },
      json: {
        [diagnosticKey]: failedDiagnostic({ failedAt: "2026-08-21T00:00:00.000Z" })
      }
    });
    const recentResult = await prepareRawRetentionIntents({
      pool: {} as never,
      clickhouse: {} as never,
      storage: recent.storage,
      queue: fakeQueue({ batch_1: "failed" }),
      projectId: PROJECT_ID,
      objectKeys: [OLD_KEY],
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z")
    });
    expect(recentResult.skipped).toEqual([
      { objectKey: OLD_KEY, reason: "failed_diagnostic_inside_retention_window" }
    ]);

    const oversized = fakeStorage({
      stats: {
        [OLD_KEY]: { key: OLD_KEY, sizeBytes: 1 },
        [diagnosticKey]: {
          key: diagnosticKey,
          sizeBytes: RAW_RETENTION_FAILED_DIAGNOSTIC_MAX_BYTES + 1
        }
      }
    });
    const oversizedResult = await prepareRawRetentionIntents({
      pool: {} as never,
      clickhouse: {} as never,
      storage: oversized.storage,
      queue: fakeQueue({ batch_1: "failed" }),
      projectId: PROJECT_ID,
      objectKeys: [OLD_KEY],
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z")
    });
    expect(oversizedResult.skipped).toEqual([
      { objectKey: OLD_KEY, reason: "failed_diagnostic_invalid" }
    ]);
    expect(oversized.storage.getJson).not.toHaveBeenCalled();
    expect(getRawObjectRefSnapshot).not.toHaveBeenCalled();
  });

  it("vetoes pending refs, query-visible rows, and in-window diagnostics", async () => {
    const second = `raw/${PROJECT_ID}/2025/01/02/batch_2.json`;
    const third = `raw/${PROJECT_ID}/2025/01/03/batch_3.json`;
    const { storage } = fakeStorage({
      stats: {
        [OLD_KEY]: { key: OLD_KEY, sizeBytes: 1 },
        [second]: { key: second, sizeBytes: 1 },
        [third]: { key: third, sizeBytes: 1 }
      }
    });
    getRawObjectRefSnapshot
      .mockResolvedValueOnce({ refs: [{ traceId: "trace_1", applied: 0 }], truncated: false })
      .mockResolvedValueOnce({ refs: [{ traceId: "trace_2", applied: 1 }], truncated: false })
      .mockResolvedValueOnce({ refs: [{ traceId: "trace_3", applied: 1 }], truncated: false });
    getRetentionVisibleTraceIds.mockResolvedValueOnce(new Set(["trace_2"]));
    inspectIngestFailuresForObject
      .mockResolvedValueOnce({ count: 0, newestCreatedAt: null, truncated: false })
      .mockResolvedValueOnce({
        count: 1,
        newestCreatedAt: new Date("2026-06-01T00:00:00.000Z"),
        truncated: false
      });

    const result = await prepareRawRetentionIntents({
      pool: {} as never,
      clickhouse: {} as never,
      storage,
      queue: fakeQueue(),
      projectId: PROJECT_ID,
      objectKeys: [OLD_KEY, second, third],
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z")
    });

    expect(result.skipped).toEqual([
      { objectKey: OLD_KEY, reason: "pending_trace_refs" },
      { objectKey: second, reason: "query_visible_trace_rows" },
      { objectKey: third, reason: "diagnostic_inside_retention_window" }
    ]);
  });

  it("rejects object-count and aggregate-byte overflows before creating intents", async () => {
    const tooMany = Array.from(
      { length: RAW_RETENTION_PREPARE_MAX_OBJECTS + 1 },
      (_, index) => `raw/${PROJECT_ID}/2025/01/01/batch_${index}.json`
    );
    const empty = fakeStorage();
    await expect(
      prepareRawRetentionIntents({
        pool: {} as never,
        clickhouse: {} as never,
        storage: empty.storage,
        queue: fakeQueue(),
        projectId: PROJECT_ID,
        objectKeys: tooMany,
        defaultRetentionDays: 90
      })
    ).rejects.toThrow("capped");

    const second = `raw/${PROJECT_ID}/2025/01/02/batch_2.json`;
    const oversized = fakeStorage({
      stats: {
        [OLD_KEY]: { key: OLD_KEY, sizeBytes: RAW_RETENTION_PREPARE_MAX_BYTES },
        [second]: { key: second, sizeBytes: 1 }
      }
    });
    await expect(
      prepareRawRetentionIntents({
        pool: {} as never,
        clickhouse: {} as never,
        storage: oversized.storage,
        queue: fakeQueue(),
        projectId: PROJECT_ID,
        objectKeys: [OLD_KEY, second],
        defaultRetentionDays: 90,
        now: new Date("2026-08-21T00:00:00.000Z")
      })
    ).rejects.toThrow("byte cap");
    expect(createRawRetentionIntents).not.toHaveBeenCalled();
  });

  it("vetoes diagnostic overflow and aborts on a bounded visibility-query failure", async () => {
    const storage = fakeStorage({
      stats: { [OLD_KEY]: { key: OLD_KEY, sizeBytes: 1 } }
    });
    inspectIngestFailuresForObject.mockResolvedValueOnce({
      count: 1_000,
      newestCreatedAt: new Date("2025-01-01T00:00:00.000Z"),
      truncated: true
    });
    const capped = await prepareRawRetentionIntents({
      pool: {} as never,
      clickhouse: {} as never,
      storage: storage.storage,
      queue: fakeQueue(),
      projectId: PROJECT_ID,
      objectKeys: [OLD_KEY],
      defaultRetentionDays: 90,
      now: new Date("2026-08-21T00:00:00.000Z")
    });
    expect(capped.skipped).toEqual([{ objectKey: OLD_KEY, reason: "diagnostic_row_cap" }]);

    inspectIngestFailuresForObject.mockResolvedValue({
      count: 0,
      newestCreatedAt: null,
      truncated: false
    });
    getRetentionVisibleTraceIds.mockRejectedValueOnce(new Error("ClickHouse read limit"));
    await expect(
      prepareRawRetentionIntents({
        pool: {} as never,
        clickhouse: {} as never,
        storage: storage.storage,
        queue: fakeQueue(),
        projectId: PROJECT_ID,
        objectKeys: [OLD_KEY],
        defaultRetentionDays: 90,
        now: new Date("2026-08-21T00:00:00.000Z")
      })
    ).rejects.toThrow("ClickHouse read limit");
    expect(createRawRetentionIntents).toHaveBeenCalledTimes(1);
    expect(createRawRetentionIntents).toHaveBeenLastCalledWith(expect.anything(), []);
  });

  it("aborts before intent writes when aggregate trace or diagnostic work exceeds its cap", async () => {
    const second = `raw/${PROJECT_ID}/2025/01/02/batch_2.json`;
    const traceHeavy = fakeStorage({
      stats: {
        [OLD_KEY]: { key: OLD_KEY, sizeBytes: 1 },
        [second]: { key: second, sizeBytes: 1 }
      }
    });
    getRawObjectRefSnapshot
      .mockResolvedValueOnce({
        refs: Array.from({ length: 10_000 }, (_, index) => ({
          traceId: `trace_${index}`,
          applied: 1
        })),
        truncated: false
      })
      .mockResolvedValueOnce({ refs: [{ traceId: "one_too_many", applied: 1 }], truncated: false });
    await expect(
      prepareRawRetentionIntents({
        pool: {} as never,
        clickhouse: {} as never,
        storage: traceHeavy.storage,
        queue: fakeQueue(),
        projectId: PROJECT_ID,
        objectKeys: [OLD_KEY, second],
        defaultRetentionDays: 90,
        now: new Date("2026-08-21T00:00:00.000Z")
      })
    ).rejects.toThrow("aggregate trace-id cap");

    getRawObjectRefSnapshot.mockReset();
    getRawObjectRefSnapshot.mockResolvedValue({
      refs: [{ traceId: "x".repeat(1024 * 1024 + 1), applied: 1 }],
      truncated: false
    });
    await expect(
      prepareRawRetentionIntents({
        pool: {} as never,
        clickhouse: {} as never,
        storage: traceHeavy.storage,
        queue: fakeQueue(),
        projectId: PROJECT_ID,
        objectKeys: [OLD_KEY],
        defaultRetentionDays: 90,
        now: new Date("2026-08-21T00:00:00.000Z")
      })
    ).rejects.toThrow("aggregate trace-id byte cap");

    vi.clearAllMocks();
    getProject.mockResolvedValue({
      id: PROJECT_ID,
      organizationId: "org_1",
      name: "Test",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      rateLimitPerMinute: null,
      retentionDays: null,
      traceQuietPeriodSeconds: null
    });
    getRawObjectRefSnapshot.mockResolvedValue({
      refs: [{ traceId: "trace_1", applied: 1 }],
      truncated: false
    });
    inspectIngestFailuresForObject.mockResolvedValue({
      count: 1_000,
      newestCreatedAt: new Date("2025-01-01T00:00:00.000Z"),
      truncated: false
    });
    const diagnosticKeys = Array.from(
      { length: 11 },
      (_, index) => `raw/${PROJECT_ID}/2025/01/${String(index + 1).padStart(2, "0")}/batch_${index}.json`
    );
    const diagnosticHeavy = fakeStorage({
      stats: Object.fromEntries(
        diagnosticKeys.map((key) => [key, { key, sizeBytes: 1 }])
      )
    });
    await expect(
      prepareRawRetentionIntents({
        pool: {} as never,
        clickhouse: {} as never,
        storage: diagnosticHeavy.storage,
        queue: fakeQueue(),
        projectId: PROJECT_ID,
        objectKeys: diagnosticKeys,
        defaultRetentionDays: 90,
        now: new Date("2026-08-21T00:00:00.000Z")
      })
    ).rejects.toThrow("aggregate diagnostic-row cap");
    expect(createRawRetentionIntents).not.toHaveBeenCalled();
  });
});
