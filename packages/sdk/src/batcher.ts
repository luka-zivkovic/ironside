import type { IngestRequestEvent } from "./types.js";

export interface BatcherOptions {
  apiKey: string;
  host: string;
  /** Flush automatically once this many events are buffered. */
  maxBatchSize?: number;
  /** Flush automatically after this many ms, even if under maxBatchSize. */
  flushIntervalMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Called with a failed batch's events + the error; default: console.error. Never throws back into the caller's hot path. */
  onError?: (error: unknown, events: IngestRequestEvent[]) => void;
  /** Retries after the first attempt for a batch that failed with a network error, 408, 429, or 5xx. 0 disables retries. Default 5. */
  maxRetries?: number;
  /** Base delay for exponential backoff between retries. A server `Retry-After` header takes precedence. Default 500 ms. */
  retryDelayMs?: number;
  /** Most events held in memory at once, buffered or waiting to send. Events beyond it are dropped and reported via onError. Default 10,000. */
  maxQueuedEvents?: number;
  /** Longest close() waits for pending sends and retries before reporting the remainder via onError. Default 10,000 ms. */
  shutdownTimeoutMs?: number;
}

const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_QUEUED_EVENTS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
// The API's rate limiter uses one-minute windows, so no single wait needs to
// be longer than that.
const MAX_RETRY_DELAY_MS = 60_000;

type SendOutcome =
  | { kind: "sent" }
  | { kind: "rejected"; error: Error }
  | { kind: "retryable"; error: unknown; retryAfterMs?: number };

/** 408/429/5xx are transient; any other 4xx will fail the same way again. 501 means the route itself is unsupported. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status !== 501);
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  if (Number.isNaN(ms)) return undefined;
  return Math.min(Math.max(ms, 0), MAX_RETRY_DELAY_MS);
}

/**
 * Buffers ingest events in memory and flushes them to POST /api/v1/ingest
 * in the background — instrumentation calls (trace/span/generation) never
 * block on network I/O. Flushes are fire-and-forget from the caller's
 * perspective; failures are reported via onError, not thrown, since a
 * trace SDK must never be the reason an application request fails.
 *
 * Transient failures (network errors, 408, 429, 5xx) are retried with
 * exponential backoff before a batch is reported as failed. Retrying is
 * safe because every event body carries a client-generated id, so a batch
 * the server did accept before the connection dropped upserts the same rows
 * again instead of duplicating them.
 */
export class EventBatcher {
  private readonly apiKey: string;
  private readonly host: string;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (error: unknown, events: IngestRequestEvent[]) => void;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxQueuedEvents: number;
  private readonly shutdownTimeoutMs: number;

  private buffer: IngestRequestEvent[] = [];
  /** Events claimed by flush() whose send has not settled yet. */
  private queuedCount = 0;
  /** Events refused because the queue was full, reported together on the next flush. */
  private dropped: IngestRequestEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private closed = false;
  /** Aborted when close()'s timeout expires: cancels the request in flight and any retry wait. */
  private readonly closeTimeout = new AbortController();

  constructor(options: BatcherOptions) {
    this.apiKey = options.apiKey;
    this.host = options.host.replace(/\/$/, "");
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onError =
      options.onError ??
      ((error) => console.error("[ironside] failed to send trace events:", error));
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.maxQueuedEvents = Math.max(1, options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS);
    this.shutdownTimeoutMs = Math.max(0, options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);

    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    // Don't let the flush timer keep the process alive on its own.
    this.timer.unref?.();
  }

  enqueue(event: IngestRequestEvent): void {
    if (this.closed) return;
    // Retries hold batches in memory while the server is unreachable, so the
    // total is capped rather than letting a long outage grow it without bound.
    if (this.buffer.length + this.queuedCount >= this.maxQueuedEvents) {
      this.dropped.push(event);
      return;
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  /** Sends whatever is currently buffered. Safe to call concurrently — flushes serialize via inFlight. */
  async flush(): Promise<void> {
    this.reportDropped();
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    this.queuedCount += events.length;

    this.inFlight = this.inFlight.then(() => this.send(events));
    await this.inFlight;
  }

  private reportDropped(): void {
    if (this.dropped.length === 0) return;
    const events = this.dropped;
    this.dropped = [];
    this.onError(
      new Error(
        `ironside send queue is full (${this.maxQueuedEvents} events); dropped ${events.length} event(s)`
      ),
      events
    );
  }

  private async send(events: IngestRequestEvent[]): Promise<void> {
    try {
      for (let attempt = 0; ; attempt += 1) {
        const outcome = await this.attempt(events);
        if (outcome.kind === "sent") return;
        if (outcome.kind === "rejected" || attempt >= this.maxRetries) {
          this.onError(outcome.error, events);
          return;
        }
        const delayMs = outcome.retryAfterMs ?? this.backoffMs(attempt);
        if (!(await this.wait(delayMs))) {
          this.onError(outcome.error, events);
          return;
        }
      }
    } finally {
      this.queuedCount -= events.length;
    }
  }

  private async attempt(events: IngestRequestEvent[]): Promise<SendOutcome> {
    try {
      const res = await this.fetchImpl(`${this.host}/api/v1/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ events }),
        signal: this.closeTimeout.signal
      });
      // Release the connection; the ingest response body carries nothing the SDK uses.
      await res.body?.cancel().catch(() => {});
      if (res.ok) return { kind: "sent" };
      const error = new Error(`ingest request failed: HTTP ${res.status}`);
      if (!isRetryableStatus(res.status)) return { kind: "rejected", error };
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      return retryAfterMs === undefined
        ? { kind: "retryable", error }
        : { kind: "retryable", error, retryAfterMs };
    } catch (error) {
      return { kind: "retryable", error };
    }
  }

  /** Exponential backoff with equal jitter: half the step is fixed, half random, so many clients don't retry in lockstep. */
  private backoffMs(attempt: number): number {
    const step = Math.min(this.retryDelayMs * 2 ** attempt, MAX_RETRY_DELAY_MS);
    return step / 2 + Math.random() * (step / 2);
  }

  /** Resolves true after `ms`, or false as soon as close()'s timeout expires. */
  private wait(ms: number): Promise<boolean> {
    const signal = this.closeTimeout.signal;
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      // Deliberately not unref'd: a pending retry is unsent data, like a request in flight.
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Stops the background timer and flushes any remaining buffered events.
   * Call on process shutdown.
   *
   * Must wait on `inFlight` explicitly, not just call `flush()` — if a
   * different caller (the interval timer, or an enqueue() that just hit
   * maxBatchSize) already claimed the buffer into its own in-progress
   * send() moments earlier, flush() here sees an empty buffer and returns
   * immediately without waiting for that still-pending request. Without
   * this, shutdown() could resolve while a real network request is still
   * in flight, and an immediately-following process.exit() would silently
   * drop that batch.
   *
   * Waiting is bounded by `shutdownTimeoutMs`: when it expires, the request
   * in flight and any retry wait are cancelled and every unsent batch is
   * reported through onError, so a server outage cannot stall shutdown.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    const deadline = setTimeout(() => this.closeTimeout.abort(), this.shutdownTimeoutMs);
    try {
      await this.flush();
      await this.inFlight;
    } finally {
      clearTimeout(deadline);
    }
  }
}
