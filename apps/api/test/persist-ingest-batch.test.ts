import type { QueueMessage, IngestBatch } from "@ironside/shared";
import { pendingIngestObjectKey, rawObjectKey } from "@ironside/shared";
import type { ObjectStorage } from "@ironside/storage";
import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { persistAndEnqueueIngestBatch } from "../src/lib/persist-ingest-batch.js";

function batch(): IngestBatch {
  return {
    batchId: "batch_1",
    projectId: "proj_1",
    receivedAt: "2026-08-21T10:00:00.000Z",
    events: [
      {
        id: "event_1",
        type: "trace-upsert",
        source: "native",
        schemaVersion: 1,
        idempotencyKey: "same-event",
        body: { id: "trace_1", timestamp: "2026-08-21T10:00:00.000Z" }
      }
    ]
  };
}

describe("persistAndEnqueueIngestBatch", () => {
  it("writes raw data and the durable intent before enqueueing", async () => {
    const calls: string[] = [];
    const storage = {
      putJson: vi.fn(async (key: string) => {
        calls.push(`put:${key}`);
      })
    } as unknown as ObjectStorage;
    const queue = {
      add: vi.fn(async () => {
        calls.push("enqueue");
      })
    } as unknown as Queue<QueueMessage>;
    const value = batch();

    const message = await persistAndEnqueueIngestBatch({ storage, queue }, value);

    expect(message.objectKey).toBe(rawObjectKey("proj_1", new Date(value.receivedAt), "batch_1"));
    expect(message.intentCreatedAt).toBe(value.receivedAt);
    expect(calls).toEqual([
      `put:${message.objectKey}`,
      `put:${pendingIngestObjectKey("batch_1")}`,
      "enqueue"
    ]);
  });

  it("does not enqueue if the durable intent write fails", async () => {
    let writes = 0;
    const storage = {
      putJson: vi.fn(async () => {
        writes += 1;
        if (writes === 2) throw new Error("intent write failed");
      })
    } as unknown as ObjectStorage;
    const queue = { add: vi.fn() } as unknown as Queue<QueueMessage>;

    await expect(
      persistAndEnqueueIngestBatch({ storage, queue }, batch())
    ).rejects.toThrow("intent write failed");
    expect(queue.add).not.toHaveBeenCalled();
  });
});
