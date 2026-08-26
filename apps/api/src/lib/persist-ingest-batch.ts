import { enqueueBatch } from "@ironside/queue";
import {
  pendingIngestObjectKey,
  rawObjectKey,
  type IngestBatch,
  type QueueMessage
} from "@ironside/shared";
import type { ObjectStorage } from "@ironside/storage";
import type { Queue } from "bullmq";

export interface PersistIngestBatchDeps {
  storage: ObjectStorage;
  queue: Queue<QueueMessage>;
}

/**
 * Stores the immutable batch and a durable queue intent before touching
 * Redis. The worker removes the intent only after materialization succeeds;
 * if Redis loses an acknowledged job, the recovery loop can enqueue the
 * exact same message again from object storage.
 */
export async function persistAndEnqueueIngestBatch(
  deps: PersistIngestBatchDeps,
  batch: IngestBatch
): Promise<QueueMessage> {
  const receivedAt = new Date(batch.receivedAt);
  const message: QueueMessage = {
    batchId: batch.batchId,
    projectId: batch.projectId,
    objectKey: rawObjectKey(batch.projectId, receivedAt, batch.batchId),
    eventCount: batch.events.length,
    intentCreatedAt: batch.receivedAt
  };
  const pendingKey = pendingIngestObjectKey(batch.batchId);

  // Ordering is correctness-critical: an acknowledged queue job must never
  // refer to an absent raw object or lack its durable recovery intent.
  await deps.storage.putJson(message.objectKey, batch);
  await deps.storage.putJson(pendingKey, message);
  await enqueueBatch(deps.queue, message);
  return message;
}
