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
}

const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;

/**
 * Buffers ingest events in memory and flushes them to POST /api/v1/ingest
 * in the background — instrumentation calls (trace/span/generation) never
 * block on network I/O. Flushes are fire-and-forget from the caller's
 * perspective; failures are reported via onError, not thrown, since a
 * trace SDK must never be the reason an application request fails.
 */
export class EventBatcher {
  private readonly apiKey: string;
  private readonly host: string;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (error: unknown, events: IngestRequestEvent[]) => void;

  private buffer: IngestRequestEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: BatcherOptions) {
    this.apiKey = options.apiKey;
    this.host = options.host.replace(/\/$/, "");
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onError =
      options.onError ??
      ((error) => console.error("[ironside] failed to send trace events:", error));

    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    // Don't let the flush timer keep the process alive on its own.
    this.timer.unref?.();
  }

  enqueue(event: IngestRequestEvent): void {
    if (this.closed) return;
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  /** Sends whatever is currently buffered. Safe to call concurrently — flushes serialize via inFlight. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];

    this.inFlight = this.inFlight.then(() => this.send(events));
    await this.inFlight;
  }

  private async send(events: IngestRequestEvent[]): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.host}/api/v1/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ events })
      });
      if (!res.ok) {
        this.onError(new Error(`ingest request failed: HTTP ${res.status}`), events);
      }
    } catch (error) {
      this.onError(error, events);
    }
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
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush();
    await this.inFlight;
  }
}
