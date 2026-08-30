import { enqueueBatch } from "@ironside/queue";
import {
  failedIngestObjectKey,
  PENDING_INGEST_CURSOR_KEY,
  PENDING_INGEST_INTERNAL_PREFIX,
  PENDING_INGEST_PREFIX,
  pendingIngestObjectKey,
  queueMessageSchema,
  type QueueMessage
} from "@ironside/shared";
import {
  InvalidJsonObjectError,
  isObjectNotFoundError,
  type ObjectStorage
} from "@ironside/storage";
import type { Queue } from "bullmq";

export interface PendingIngestRecoveryResult {
  examined: number;
  enqueued: number;
  alreadyQueued: number;
  completedCleaned: number;
  terminalFailed: number;
  retentionBlockedCleaned: number;
  disappeared: number;
  invalid: number;
}

export interface PendingIngestReconciler {
  run(): Promise<PendingIngestRecoveryResult>;
}

export interface PendingIngestReconcilerOptions {
  storage: ObjectStorage;
  queue: Queue<QueueMessage>;
  /** Maximum pending intents examined in one run. */
  batchSize?: number;
  onInvalid?: (key: string, error: unknown) => void;
  now?: () => Date;
  /** Optional enabled-retention coordination; absent means zero hot-path overhead. */
  coordinateMessage?: <T>(message: QueueMessage, operation: () => Promise<T>) => Promise<T>;
  isRetentionBlocked?: (message: QueueMessage) => Promise<boolean>;
  /** Settle any cross-store commit before a terminal queue job is quarantined. */
  beforeTerminalFailure?: (
    message: QueueMessage
  ) => Promise<"quarantine" | "retry">;
}

const DEFAULT_BATCH_SIZE = 1_000;

interface RecoveryCursor {
  after?: string;
  cycleStartedAt: string;
}

/**
 * Rebuilds Redis work from durable pending intents. Keys are global
 * creation-ordered batch ULIDs; a persisted cursor advances bounded passes
 * beyond live jobs. Each cycle captures its acceptance-time high-water mark,
 * so continuous new ingestion cannot postpone a wrap forever. Stable queue job
 * ids and idempotent sidecar writes make concurrent reconcilers benign.
 */
export function createPendingIngestReconciler(
  options: PendingIngestReconcilerOptions
): PendingIngestReconciler {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("pending ingest recovery batchSize must be a positive integer");
  }

  return {
    async run() {
      const result: PendingIngestRecoveryResult = {
        examined: 0,
        enqueued: 0,
        alreadyQueued: 0,
        completedCleaned: 0,
        terminalFailed: 0,
        retentionBlockedCleaned: 0,
        disappeared: 0,
        invalid: 0
      };

      const cursor = await readCursor(options);
      let lastExamined: string | undefined;
      let reachedCycleBoundary = false;

      for await (const key of options.storage.list(
        PENDING_INGEST_PREFIX,
        cursor.after ? { startAfter: cursor.after } : undefined
      )) {
        // Permission probes and the persisted cursor share the bucket prefix
        // but are not queue intents and never consume the bounded work budget.
        if (key.startsWith(PENDING_INGEST_INTERNAL_PREFIX)) continue;
        if (result.examined >= batchSize) break;
        const outcome = await reconcileIntent(
          options,
          key,
          cursor.cycleStartedAt,
          result
        );
        if (outcome === "after-cycle") {
          reachedCycleBoundary = true;
          break;
        }
        result.examined += 1;
        lastExamined = key;
      }

      if (reachedCycleBoundary) {
        // Intents accepted after this cycle began belong to the next cycle.
        // Wrap now even if newer keys keep arriving before every pass.
        await options.storage.delete(PENDING_INGEST_CURSOR_KEY);
      } else if (lastExamined) {
        // Persist progress so a live oldest job cannot consume every bounded
        // pass after a process or container restart. A crash before this write
        // only repeats idempotent inspection; a crash after it resumes later.
        await options.storage.putJson(PENDING_INGEST_CURSOR_KEY, {
          after: lastExamined,
          cycleStartedAt: cursor.cycleStartedAt
        });
      } else if (cursor.after) {
        // The suffix is empty: wrap the next pass to the oldest still-pending
        // marker.
        await options.storage.delete(PENDING_INGEST_CURSOR_KEY);
      }
      return result;
    }
  };
}

async function reconcileIntent(
  options: PendingIngestReconcilerOptions,
  key: string,
  cycleStartedAt: string,
  result: PendingIngestRecoveryResult
): Promise<"examined" | "after-cycle"> {
  let stored: unknown;
  try {
    stored = await options.storage.getJson(key);
  } catch (error) {
    if (isObjectNotFoundError(error)) {
      // Normal list→GET race with a worker deleting its commit marker.
      result.disappeared += 1;
      return "examined";
    }
    if (error instanceof InvalidJsonObjectError) {
      await discardInvalidIntent(options, key, error);
      result.invalid += 1;
      return "examined";
    }
    throw error;
  }

  const parsed = queueMessageSchema.safeParse(stored);
  if (!parsed.success) {
    await discardInvalidIntent(
      options,
      key,
      new Error(`invalid pending ingest message: ${parsed.error.message}`)
    );
    result.invalid += 1;
    return "examined";
  }
  const message = parsed.data;
  const expectedKey = pendingIngestObjectKey(message.batchId);
  if (key !== expectedKey || !rawKeyMatchesMessage(message)) {
    await discardInvalidIntent(
      options,
      key,
      new Error("pending key or raw object key does not match its message")
    );
    result.invalid += 1;
    return "examined";
  }

  if (
    message.intentCreatedAt !== undefined &&
    Date.parse(message.intentCreatedAt) > Date.parse(cycleStartedAt)
  ) {
    return "after-cycle";
  }

  const reconcileValidatedMessage = async (): Promise<void> => {
    if (await options.isRetentionBlocked?.(message)) {
      // The executor has crossed its irreversible boundary (or completed).
      // Clean a delayed recovery marker instead of re-enqueueing or recreating
      // a terminal-failure sidecar for deliberately retired raw history.
      await options.storage.delete(key);
      result.retentionBlockedCleaned += 1;
      return;
    }

    // Queue errors are deliberately not classified as invalid durable intents.
    // Let the run fail with the marker still present so a Redis outage retries
    // this exact object on the next tick.
    const existing = await options.queue.getJob(message.batchId);
    if (!existing) {
      await enqueueBatch(options.queue, message);
      result.enqueued += 1;
      return;
    }

    const state = await existing.getState();
    if (state === "completed") {
      // The worker may complete between this reconciler reading the marker
      // and inspecting the queue. Completion is authoritative; make the
      // marker deletion idempotent instead of replaying.
      await options.storage.delete(key);
      result.completedCleaned += 1;
    } else if (state === "failed") {
      // Some processors have a durable cross-store commit before their final
      // acknowledgement. If settlement is temporarily unavailable, fail this
      // reconciliation pass and keep the pending marker for the next tick.
      const recoveryAction = await options.beforeTerminalFailure?.(message) ?? "quarantine";
      if (recoveryAction === "retry") {
        await existing.retry("failed");
        result.enqueued += 1;
        return;
      }
      // Respect BullMQ's finite retry policy. Move terminal diagnostics out of
      // the hot pending prefix instead of retrying a poison batch forever.
      await options.storage.putJson(failedIngestObjectKey(message.batchId), {
        ...message,
        failedAt: new Date().toISOString(),
        attemptsMade: existing.attemptsMade,
        reason: (existing.failedReason ?? "ingest job exhausted retries").slice(0, 2_000)
      });
      await options.storage.delete(key);
      result.terminalFailed += 1;
    } else {
      result.alreadyQueued += 1;
    }
  };

  if (options.coordinateMessage) {
    await options.coordinateMessage(message, reconcileValidatedMessage);
  } else {
    await reconcileValidatedMessage();
  }
  return "examined";
}

async function readCursor(options: PendingIngestReconcilerOptions): Promise<RecoveryCursor> {
  const cycleStartedAt = (options.now?.() ?? new Date()).toISOString();
  let stored: unknown;
  try {
    stored = await options.storage.getJson(PENDING_INGEST_CURSOR_KEY);
  } catch (error) {
    if (isObjectNotFoundError(error)) return { cycleStartedAt };
    if (error instanceof InvalidJsonObjectError) {
      options.onInvalid?.(PENDING_INGEST_CURSOR_KEY, error);
      await options.storage.delete(PENDING_INGEST_CURSOR_KEY);
      return { cycleStartedAt };
    }
    throw error;
  }

  const after =
    typeof stored === "object" && stored !== null
      ? (stored as { after?: unknown }).after
      : undefined;
  const storedCycleStartedAt =
    typeof stored === "object" && stored !== null
      ? (stored as { cycleStartedAt?: unknown }).cycleStartedAt
      : undefined;
  if (
    typeof after === "string" &&
    after.startsWith(PENDING_INGEST_PREFIX) &&
    !after.startsWith(PENDING_INGEST_INTERNAL_PREFIX) &&
    after.endsWith(".json")
  ) {
    if (
      typeof storedCycleStartedAt === "string" &&
      Number.isFinite(Date.parse(storedCycleStartedAt)) &&
      Date.parse(storedCycleStartedAt) <= Date.parse(cycleStartedAt)
    ) {
      return { after, cycleStartedAt: storedCycleStartedAt };
    }
  }

  const error = new Error("invalid pending ingest recovery cursor");
  options.onInvalid?.(PENDING_INGEST_CURSOR_KEY, error);
  await options.storage.delete(PENDING_INGEST_CURSOR_KEY);
  return { cycleStartedAt };
}

async function discardInvalidIntent(
  options: PendingIngestReconcilerOptions,
  key: string,
  error: unknown
): Promise<void> {
  options.onInvalid?.(key, error);
  // The sidecar is derived recovery state, never the forensic source. Remove
  // it so corrupt internal metadata cannot head-of-line block valid intents;
  // the immutable raw archive remains untouched for manual recovery.
  await options.storage.delete(key);
}

function rawKeyMatchesMessage(message: QueueMessage): boolean {
  const parts = message.objectKey.split("/");
  return (
    parts.length === 6 &&
    parts[0] === "raw" &&
    parts[1] === message.projectId &&
    /^\d{4}$/.test(parts[2] ?? "") &&
    /^(0[1-9]|1[0-2])$/.test(parts[3] ?? "") &&
    /^(0[1-9]|[12]\d|3[01])$/.test(parts[4] ?? "") &&
    parts[5] === `${message.batchId}.json`
  );
}
