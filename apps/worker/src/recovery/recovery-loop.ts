import type { QueueMessage } from "@ironside/shared";
import {
  getRawRetentionIntent,
  withRawRetentionObjectLock
} from "@ironside/db";
import type { ObjectStorage } from "@ironside/storage";
import type { Queue } from "bullmq";
import type { Pool } from "pg";
import {
  createPendingIngestReconciler,
  type PendingIngestRecoveryResult
} from "./pending-ingest-reconciler.js";

export interface RecoveryLoop {
  stop(): void;
}

export interface RecoveryLoopOptions {
  storage: ObjectStorage;
  queue: Queue<QueueMessage>;
  intervalMs?: number;
  batchSize?: number;
  onResult?: (result: PendingIngestRecoveryResult) => void;
  onError?: (error: unknown) => void;
  pool?: Pool;
  retentionExecutionEnabled?: boolean;
  beforeTerminalFailure?: (
    message: QueueMessage
  ) => Promise<"quarantine" | "retry">;
}

const DEFAULT_INTERVAL_MS = 30_000;

export function startPendingIngestRecovery(options: RecoveryLoopOptions): RecoveryLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new Error("pending ingest recovery intervalMs must be positive");
  }
  const reconciler = createPendingIngestReconciler({
    storage: options.storage,
    queue: options.queue,
    ...(options.batchSize !== undefined && { batchSize: options.batchSize }),
    onInvalid: (key, error) =>
      console.error(`[ingest-recovery] invalid durable intent ${key}:`, error),
    ...(options.beforeTerminalFailure
      ? { beforeTerminalFailure: options.beforeTerminalFailure }
      : {}),
    ...(options.pool && options.retentionExecutionEnabled === true
      ? {
          coordinateMessage: <T>(message: QueueMessage, operation: () => Promise<T>) =>
            withRawRetentionObjectLock(
              options.pool!,
              message.projectId,
              message.objectKey,
              operation
            ),
          isRetentionBlocked: async (message: QueueMessage) => {
            const intent = await getRawRetentionIntent(
              options.pool!,
              message.projectId,
              message.objectKey
            );
            return intent?.state === "executing" || intent?.state === "complete";
          }
        }
      : {})
  });

  let stopped = false;
  let running = false;
  async function tick(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      options.onResult?.(await reconciler.run());
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}
