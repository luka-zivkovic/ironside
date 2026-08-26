import {
  failedIngestObjectKey,
  PENDING_INGEST_CURSOR_KEY,
  PENDING_INGEST_PROBE_PREFIX,
  pendingIngestObjectKey,
  rawObjectKey,
  type QueueMessage
} from "@ironside/shared";
import { InvalidJsonObjectError, type ObjectStorage } from "@ironside/storage";
import type { Job, Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { createPendingIngestReconciler } from "../src/recovery/pending-ingest-reconciler.js";
import { verifyPendingIngestStorage } from "../src/recovery/storage-permissions.js";

const day = new Date("2026-08-21T10:00:00.000Z");
const MALFORMED_BYTES = Symbol("malformed-json-bytes");
const MISSING_ON_GET = Symbol("list-get-race");

function message(batchId: string, intentCreatedAt = day.toISOString()): QueueMessage {
  return {
    batchId,
    projectId: "proj_1",
    objectKey: rawObjectKey("proj_1", day, batchId),
    eventCount: 1,
    intentCreatedAt
  };
}

type FakeStorage = ObjectStorage & { values: Map<string, unknown> };

function fakeStorage(entries: [string, unknown][]): FakeStorage {
  const values = new Map(entries);
  return {
    values,
    async *list(prefix: string, options?: { startAfter?: string }) {
      for (const key of [...values.keys()].sort()) {
        if (
          key.startsWith(prefix) &&
          (options?.startAfter === undefined || key > options.startAfter)
        ) {
          yield key;
        }
      }
    },
    async getJson(key: string) {
      if (!values.has(key)) {
        throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
      }
      const value = values.get(key);
      if (value === MALFORMED_BYTES) {
        throw new InvalidJsonObjectError(key, new SyntaxError("bad JSON"));
      }
      if (value === MISSING_ON_GET) {
        values.delete(key);
        throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
      }
      return value;
    },
    async putJson(key: string, value: unknown) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
    async exists(key: string) {
      return values.has(key);
    }
  } as unknown as FakeStorage;
}

function fakeJob(state: string, overrides: Partial<Job<QueueMessage>> = {}) {
  return {
    getState: async () => state,
    attemptsMade: 5,
    failedReason: "clickhouse unavailable",
    ...overrides
  } as unknown as Job<QueueMessage>;
}

function fakeQueue(jobs: Map<string, Job<QueueMessage> | undefined> = new Map()) {
  return {
    getJob: vi.fn(async (id: string) => jobs.get(id)),
    add: vi.fn(async () => undefined)
  } as unknown as Queue<QueueMessage>;
}

describe("pending ingest reconciler", () => {
  it("drains the oldest outstanding intents in bounded passes", async () => {
    const a = message("0001");
    const b = message("0002");
    const storage = fakeStorage([
      [pendingIngestObjectKey(a.batchId), a],
      [pendingIngestObjectKey(b.batchId), b]
    ]);
    const queue = fakeQueue();
    const reconciler = createPendingIngestReconciler({ storage, queue, batchSize: 1 });

    expect(await reconciler.run()).toMatchObject({ examined: 1, enqueued: 1 });
    await storage.delete(pendingIngestObjectKey(a.batchId));
    expect(await reconciler.run()).toMatchObject({ examined: 1, enqueued: 1 });
    expect(queue.add).toHaveBeenNthCalledWith(1, "process-batch", a, { jobId: "0001" });
    expect(queue.add).toHaveBeenNthCalledWith(2, "process-batch", b, { jobId: "0002" });
  });

  it("cleans completed jobs, quarantines terminal failures, and leaves live jobs alone", async () => {
    const failed = message("0001-failed");
    const completed = message("0002-completed");
    const live = message("0003-live");
    const storage = fakeStorage(
      [failed, completed, live].map((entry) => [pendingIngestObjectKey(entry.batchId), entry])
    );
    const queue = fakeQueue(
      new Map([
        [failed.batchId, fakeJob("failed")],
        [completed.batchId, fakeJob("completed")],
        [live.batchId, fakeJob("waiting")]
      ])
    );

    const result = await createPendingIngestReconciler({ storage, queue }).run();

    expect(result).toMatchObject({
      examined: 3,
      terminalFailed: 1,
      completedCleaned: 1,
      alreadyQueued: 1
    });
    expect(storage.values.has(pendingIngestObjectKey(failed.batchId))).toBe(false);
    expect(storage.values.has(failedIngestObjectKey(failed.batchId))).toBe(true);
    expect(storage.values.has(pendingIngestObjectKey(completed.batchId))).toBe(false);
    expect(storage.values.has(pendingIngestObjectKey(live.batchId))).toBe(true);
  });

  it("coordinates enabled retention before recovery can recreate work or sidecars", async () => {
    const retired = message("retired-failed");
    const storage = fakeStorage([
      [pendingIngestObjectKey(retired.batchId), retired]
    ]);
    const queue = fakeQueue(
      new Map([[retired.batchId, fakeJob("failed")]])
    );
    let coordinated = 0;
    const coordinateMessage = async <T>(
      _message: QueueMessage,
      operation: () => Promise<T>
    ): Promise<T> => {
      coordinated += 1;
      return operation();
    };

    const result = await createPendingIngestReconciler({
      storage,
      queue,
      coordinateMessage,
      isRetentionBlocked: async () => true
    }).run();

    expect(result).toMatchObject({ examined: 1, retentionBlockedCleaned: 1 });
    expect(coordinated).toBe(1);
    expect(storage.values.has(pendingIngestObjectKey(retired.batchId))).toBe(false);
    expect(storage.values.has(failedIngestObjectKey(retired.batchId))).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("discards malformed JSON bytes and still reaches the following valid intent", async () => {
    const valid = message("0002-valid");
    const badKey = pendingIngestObjectKey("0001-bad-json");
    const onInvalid = vi.fn();
    const storage = fakeStorage([
      [badKey, MALFORMED_BYTES],
      [pendingIngestObjectKey(valid.batchId), valid]
    ]);
    const queue = fakeQueue();

    const result = await createPendingIngestReconciler({
      storage,
      queue,
      batchSize: 2,
      onInvalid
    }).run();

    expect(result).toMatchObject({ examined: 2, invalid: 1, enqueued: 1 });
    expect(storage.values.has(badKey)).toBe(false);
    expect(onInvalid).toHaveBeenCalledTimes(1);
  });

  it("discards schema/key mismatches without blocking later entries", async () => {
    const valid = message("0003-valid");
    const storage = fakeStorage([
      [pendingIngestObjectKey("0001-bad-schema"), { nope: true }],
      [pendingIngestObjectKey("0002-wrong-key"), valid],
      [pendingIngestObjectKey(valid.batchId), valid]
    ]);
    const queue = fakeQueue();

    const result = await createPendingIngestReconciler({ storage, queue }).run();

    expect(result).toMatchObject({ examined: 3, enqueued: 1, invalid: 2 });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("treats a list-to-GET disappearance as a completed-worker race", async () => {
    const valid = message("0002-valid");
    const storage = fakeStorage([
      [pendingIngestObjectKey("0001-gone"), MISSING_ON_GET],
      [pendingIngestObjectKey(valid.batchId), valid]
    ]);
    const queue = fakeQueue();

    const result = await createPendingIngestReconciler({ storage, queue }).run();

    expect(result).toMatchObject({ examined: 2, disappeared: 1, enqueued: 1 });
  });

  it("propagates Redis errors and retries the same intent on the next run", async () => {
    const value = message("retry-after-outage");
    const storage = fakeStorage([[pendingIngestObjectKey(value.batchId), value]]);
    const queue = fakeQueue();
    vi.mocked(queue.getJob)
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValueOnce(undefined);
    const reconciler = createPendingIngestReconciler({ storage, queue });

    await expect(reconciler.run()).rejects.toThrow("redis unavailable");
    await expect(reconciler.run()).resolves.toMatchObject({ examined: 1, enqueued: 1 });
  });

  it("recovers after a syntactically malformed persisted cursor", async () => {
    const value = message("0001-missing");
    const onInvalid = vi.fn();
    const storage = fakeStorage([
      [PENDING_INGEST_CURSOR_KEY, MALFORMED_BYTES],
      [pendingIngestObjectKey(value.batchId), value]
    ]);
    const queue = fakeQueue();

    await expect(
      createPendingIngestReconciler({ storage, queue, batchSize: 1, onInvalid }).run()
    ).resolves.toMatchObject({ examined: 1, enqueued: 1 });
    expect(onInvalid).toHaveBeenCalledWith(
      PENDING_INGEST_CURSOR_KEY,
      expect.any(InvalidJsonObjectError)
    );
  });

  it("resets a future-dated cursor before scanning", async () => {
    const lost = message("0001-lost");
    const following = message("0002-following");
    const onInvalid = vi.fn();
    const storage = fakeStorage([
      [
        PENDING_INGEST_CURSOR_KEY,
        {
          after: pendingIngestObjectKey(lost.batchId),
          cycleStartedAt: "9999-01-01T00:00:00.000Z"
        }
      ],
      [pendingIngestObjectKey(lost.batchId), lost],
      [pendingIngestObjectKey(following.batchId), following]
    ]);
    const queue = fakeQueue();

    await expect(
      createPendingIngestReconciler({
        storage,
        queue,
        batchSize: 1,
        onInvalid,
        now: () => new Date("2026-08-21T13:00:00.000Z")
      }).run()
    ).resolves.toMatchObject({ examined: 1, enqueued: 1 });
    expect(queue.add).toHaveBeenCalledWith("process-batch", lost, {
      jobId: lost.batchId
    });
    expect(onInvalid).toHaveBeenCalledWith(
      PENDING_INGEST_CURSOR_KEY,
      expect.objectContaining({ message: "invalid pending ingest recovery cursor" })
    );
  });

  it("reaches older outstanding work across sustained growth and reconciler restarts", async () => {
    const victim = message("0002-victim");
    const storage = fakeStorage([[pendingIngestObjectKey(victim.batchId), victim]]);
    const queue = fakeQueue();

    for (let index = 0; index < 5; index += 1) {
      const newer = message(`100${index}-newer`);
      storage.values.set(pendingIngestObjectKey(newer.batchId), newer);
      const restarted = createPendingIngestReconciler({ storage, queue, batchSize: 1 });
      await restarted.run();
      const enqueued = vi.mocked(queue.add).mock.calls.at(-1)?.[1] as QueueMessage;
      await storage.delete(pendingIngestObjectKey(enqueued.batchId));
    }

    expect(
      vi.mocked(queue.add).mock.calls.some(
        (call) => (call[1] as QueueMessage).batchId === victim.batchId
      )
    ).toBe(true);
  });

  it("advances past a live oldest job across restarts to recover later missing work", async () => {
    const live = message("0001-live");
    const missing = message("0002-missing");
    const storage = fakeStorage([
      [pendingIngestObjectKey(live.batchId), live],
      [pendingIngestObjectKey(missing.batchId), missing]
    ]);
    const queue = fakeQueue(new Map([[live.batchId, fakeJob("active")]]));

    await expect(
      createPendingIngestReconciler({ storage, queue, batchSize: 1 }).run()
    ).resolves.toMatchObject({ examined: 1, alreadyQueued: 1, enqueued: 0 });
    expect(storage.values.get(PENDING_INGEST_CURSOR_KEY)).toEqual({
      after: pendingIngestObjectKey(live.batchId),
      cycleStartedAt: expect.any(String)
    });

    await expect(
      createPendingIngestReconciler({ storage, queue, batchSize: 1 }).run()
    ).resolves.toMatchObject({ examined: 1, enqueued: 1 });
    expect(queue.add).toHaveBeenCalledWith("process-batch", missing, {
      jobId: missing.batchId
    });
  });

  it("wraps after the cursor suffix is drained", async () => {
    const live = message("0001-live");
    const storage = fakeStorage([[pendingIngestObjectKey(live.batchId), live]]);
    const queue = fakeQueue(new Map([[live.batchId, fakeJob("waiting")]]));

    await createPendingIngestReconciler({ storage, queue, batchSize: 1 }).run();
    expect(storage.values.has(PENDING_INGEST_CURSOR_KEY)).toBe(true);

    await expect(
      createPendingIngestReconciler({ storage, queue, batchSize: 1 }).run()
    ).resolves.toMatchObject({ examined: 0 });
    expect(storage.values.has(PENDING_INGEST_CURSOR_KEY)).toBe(false);

    await expect(
      createPendingIngestReconciler({ storage, queue, batchSize: 1 }).run()
    ).resolves.toMatchObject({ examined: 1, alreadyQueued: 1 });
  });

  it("revisits lost work behind the cursor during sustained ingestion", async () => {
    const live = message("0001-live");
    const following = message("0002-following");
    const storage = fakeStorage([
      [pendingIngestObjectKey(live.batchId), live],
      [pendingIngestObjectKey(following.batchId), following]
    ]);
    const jobs = new Map<string, Job<QueueMessage> | undefined>([
      [live.batchId, fakeJob("active")]
    ]);
    const queue = fakeQueue(jobs);
    let clockCalls = 0;
    const now = () =>
      new Date(clockCalls++ === 0 ? "2026-08-21T11:00:00.000Z" : "2026-08-21T13:00:00.000Z");

    await createPendingIngestReconciler({ storage, queue, batchSize: 1, now }).run();
    jobs.delete(live.batchId);

    for (let index = 0; index < 5; index += 1) {
      const newer = message(`100${index}-newer`, "2026-08-21T12:00:00.000Z");
      storage.values.set(pendingIngestObjectKey(newer.batchId), newer);
      await createPendingIngestReconciler({ storage, queue, batchSize: 1, now }).run();
    }

    expect(
      vi.mocked(queue.add).mock.calls.some(
        (call) => (call[1] as QueueMessage).batchId === live.batchId
      )
    ).toBe(true);
  });

  it("ignores an in-flight startup probe without deleting it or consuming scan budget", async () => {
    const pending = message("0001-missing");
    const storage = fakeStorage([[pendingIngestObjectKey(pending.batchId), pending]]);
    const queue = fakeQueue();
    let announceProbe!: () => void;
    let releaseProbe!: () => void;
    const probeWritten = new Promise<void>((resolve) => {
      announceProbe = resolve;
    });
    const probeCanContinue = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const putJson = storage.putJson.bind(storage);
    storage.putJson = async (key, value) => {
      await putJson(key, value);
      if (key.startsWith(PENDING_INGEST_PROBE_PREFIX)) {
        announceProbe();
        await probeCanContinue;
      }
    };

    const verification = verifyPendingIngestStorage(storage);
    await probeWritten;
    const probeKey = [...storage.values.keys()].find((key) =>
      key.startsWith(PENDING_INGEST_PROBE_PREFIX)
    );
    expect(probeKey).toBeDefined();

    await expect(
      createPendingIngestReconciler({ storage, queue, batchSize: 1 }).run()
    ).resolves.toMatchObject({ examined: 1, invalid: 0, enqueued: 1 });
    expect(storage.values.has(probeKey!)).toBe(true);

    releaseProbe();
    await expect(verification).resolves.toBeUndefined();
  });
});
