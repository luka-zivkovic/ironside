import type { QueueMessage } from "@ironside/shared";
import { Queue, Worker, type Processor } from "bullmq";

export const INGEST_QUEUE = "ingest";

function connectionFromUrl(redisUrl: string) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
    // BullMQ requires this to be null for blocking commands in workers.
    maxRetriesPerRequest: null
  };
}

export function createIngestQueue(redisUrl: string): Queue<QueueMessage> {
  return new Queue<QueueMessage>(INGEST_QUEUE, {
    connection: connectionFromUrl(redisUrl),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { age: 3600, count: 10000 },
      removeOnFail: false
    }
  });
}

/**
 * Enqueues a stored batch for processing. jobId = batchId, so re-enqueueing
 * the same batch while it is still queued or retained is a no-op.
 */
export async function enqueueBatch(
  queue: Queue<QueueMessage>,
  message: QueueMessage
): Promise<void> {
  await queue.add("process-batch", message, { jobId: message.batchId });
}

export function createIngestWorker(
  redisUrl: string,
  processor: Processor<QueueMessage>,
  options: { concurrency?: number } = {}
): Worker<QueueMessage> {
  return new Worker<QueueMessage>(INGEST_QUEUE, processor, {
    connection: connectionFromUrl(redisUrl),
    concurrency: options.concurrency ?? 4
  });
}
