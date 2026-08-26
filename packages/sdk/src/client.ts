import { ulid } from "ulid";
import { EventBatcher, type BatcherOptions } from "./batcher.js";
import type {
  EndObservationOptions,
  ScoreOptions,
  StartGenerationOptions,
  StartSpanOptions,
  StartTraceOptions,
  UpdateTraceOptions
} from "./types.js";

export interface IronsideClientOptions {
  apiKey: string;
  /** Ironside API host, e.g. "https://ironside.example.com" or "http://localhost:8788". */
  host: string;
  maxBatchSize?: number;
  flushIntervalMs?: number;
  fetchImpl?: BatcherOptions["fetchImpl"];
  onError?: BatcherOptions["onError"];
}

export interface ObservationHandle {
  readonly id: string;
  /** Starts a child span nested under this observation. */
  span(options?: StartSpanOptions): ObservationHandle;
  /** Starts a child generation nested under this observation. */
  generation(options?: StartGenerationOptions): ObservationHandle;
  /** Marks this observation complete. Safe to call at most once meaningfully; a second call overwrites endTime. */
  end(options?: EndObservationOptions): void;
  /** Records a score (user feedback, eval result, ...) attached to this observation. */
  score(options: ScoreOptions): void;
}

export interface TraceHandle {
  readonly id: string;
  span(options?: StartSpanOptions): ObservationHandle;
  generation(options?: StartGenerationOptions): ObservationHandle;
  update(options: UpdateTraceOptions): void;
  /** Records a score (user feedback, eval result, ...) attached to this trace. */
  score(options: ScoreOptions): void;
}

export interface UploadMediaOptions {
  /** The raw bytes to store. */
  data: Uint8Array | ArrayBuffer;
  /** Real content type of the bytes, e.g. "image/png". */
  contentType: string;
}

export interface UploadedMedia {
  id: string;
  /** Compact ref string ("ironside://media/<id>") to embed in trace input/output/metadata. */
  ref: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface IronsideClient {
  trace(options?: StartTraceOptions): TraceHandle;
  /**
   * Uploads a media blob (image, audio, document, ...) and returns a
   * compact ref string to embed in trace input/output instead of the
   * bytes themselves — base64 payloads inside trace JSON bloat the
   * columnar store. Content-addressed: uploading identical bytes twice
   * returns the same asset. Unlike instrumentation calls this awaits the
   * network (the ref doesn't exist until the server has the bytes).
   */
  uploadMedia(options: UploadMediaOptions): Promise<UploadedMedia>;
  /** Sends buffered events immediately instead of waiting for the next automatic flush. */
  flush(): Promise<void>;
  /** Stops background flushing and sends any remaining buffered events. Call before process exit. */
  shutdown(): Promise<void>;
}

/**
 * Creates an Ironside client. Instrumentation calls (trace/span/generation)
 * never block on network I/O — events are buffered and flushed in the
 * background. Deliberately does NOT auto-register a process-exit handler:
 * doing that inside a library is a footgun (can't be un-registered,
 * surprising under multiple init() calls or in serverless runtimes with
 * their own lifecycle hooks). Call `shutdown()` explicitly wherever your
 * app already handles graceful shutdown.
 */
export function init(options: IronsideClientOptions): IronsideClient {
  const batcher = new EventBatcher({
    apiKey: options.apiKey,
    host: options.host,
    ...(options.maxBatchSize !== undefined && { maxBatchSize: options.maxBatchSize }),
    ...(options.flushIntervalMs !== undefined && { flushIntervalMs: options.flushIntervalMs }),
    ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
    ...(options.onError !== undefined && { onError: options.onError })
  });

  function enqueueScore(
    traceId: string,
    observationId: string | undefined,
    scoreOptions: ScoreOptions
  ): void {
    batcher.enqueue({
      type: "score-upsert",
      body: {
        id: scoreOptions.id ?? ulid(),
        traceId,
        ...(observationId && { observationId }),
        name: scoreOptions.name,
        dataType: scoreOptions.value !== undefined ? "numeric" : "categorical",
        source: scoreOptions.source ?? "api",
        ...(scoreOptions.value !== undefined && { value: scoreOptions.value }),
        ...(scoreOptions.stringValue !== undefined && { stringValue: scoreOptions.stringValue }),
        ...(scoreOptions.comment && { comment: scoreOptions.comment }),
        timestamp: new Date().toISOString(),
        metadata: scoreOptions.metadata ?? {}
      }
    });
  }

  function makeObservationHandle(
    id: string,
    traceId: string,
    type: "span" | "generation",
    parentObservationId: string | undefined,
    startOptions: StartSpanOptions | StartGenerationOptions
  ): ObservationHandle {
    const startTime = new Date().toISOString();
    const model = "model" in startOptions ? startOptions.model : undefined;
    const modelParameters =
      "modelParameters" in startOptions ? startOptions.modelParameters : undefined;

    batcher.enqueue({
      type: "observation-upsert",
      body: {
        id,
        traceId,
        ...(parentObservationId && { parentObservationId }),
        type,
        ...(startOptions.name && { name: startOptions.name }),
        startTime,
        ...(model && { model }),
        ...(modelParameters && { modelParameters }),
        ...(startOptions.input !== undefined && { input: startOptions.input }),
        metadata: startOptions.metadata ?? {}
      }
    });

    function child(childType: "span" | "generation") {
      return (options: StartSpanOptions | StartGenerationOptions = {}) =>
        makeObservationHandle(ulid(), traceId, childType, id, options);
    }

    return {
      id,
      span: child("span"),
      generation: child("generation"),
      end(endOptions: EndObservationOptions = {}) {
        batcher.enqueue({
          type: "observation-upsert",
          body: {
            id,
            traceId,
            ...(parentObservationId && { parentObservationId }),
            type,
            ...(startOptions.name && { name: startOptions.name }),
            startTime,
            endTime: new Date().toISOString(),
            level: endOptions.level ?? "default",
            ...(model && { model }),
            ...(modelParameters && { modelParameters }),
            ...(startOptions.input !== undefined && { input: startOptions.input }),
            ...(endOptions.output !== undefined && { output: endOptions.output }),
            ...(endOptions.statusMessage && { statusMessage: endOptions.statusMessage }),
            ...(endOptions.usageDetails && { usageDetails: endOptions.usageDetails }),
            ...(endOptions.costDetails && { costDetails: endOptions.costDetails }),
            metadata: { ...startOptions.metadata, ...endOptions.metadata }
          }
        });
      },
      score: (scoreOptions: ScoreOptions) => enqueueScore(traceId, id, scoreOptions)
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const host = options.host.replace(/\/$/, "");

  return {
    async uploadMedia(uploadOptions: UploadMediaOptions): Promise<UploadedMedia> {
      const body =
        uploadOptions.data instanceof ArrayBuffer
          ? new Uint8Array(uploadOptions.data)
          : uploadOptions.data;
      const res = await fetchImpl(`${host}/api/v1/media`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": uploadOptions.contentType
        },
        // DOM's BodyInit type isn't in the SDK's lib set; Uint8Array is a
        // valid fetch body in Node 18+ and browsers alike.
        body: body as unknown as NonNullable<RequestInit["body"]>
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`media upload failed: ${res.status}${text ? ` ${text}` : ""}`);
      }
      return (await res.json()) as UploadedMedia;
    },

    trace(startOptions: StartTraceOptions = {}) {
      const id = startOptions.id ?? ulid();
      // Fixed at trace-start time and reused by update() below — the trace's
      // timestamp must not drift to "whenever update() happened to be
      // called" (e.g. re-stamping it at completion time would corrupt the
      // recorded start time on every partial update).
      const timestamp = new Date().toISOString();
      batcher.enqueue({
        type: "trace-upsert",
        body: {
          id,
          timestamp,
          ...(startOptions.name && { name: startOptions.name }),
          ...(startOptions.userId && { userId: startOptions.userId }),
          ...(startOptions.sessionId && { sessionId: startOptions.sessionId }),
          ...(startOptions.environment && { environment: startOptions.environment }),
          ...(startOptions.release && { release: startOptions.release }),
          ...(startOptions.version && { version: startOptions.version }),
          tags: startOptions.tags ?? [],
          metadata: startOptions.metadata ?? {},
          ...(startOptions.input !== undefined && { input: startOptions.input })
        }
      });

      return {
        id,
        span: (options: StartSpanOptions = {}) =>
          makeObservationHandle(ulid(), id, "span", undefined, options),
        generation: (options: StartGenerationOptions = {}) =>
          makeObservationHandle(ulid(), id, "generation", undefined, options),
        update(updateOptions: UpdateTraceOptions) {
          // A trace-upsert replaces the whole row (ClickHouse
          // ReplacingMergeTree has no field-level merge) — every field set
          // by trace() must be carried forward here too, or update() would
          // silently wipe name/userId/sessionId/input back to absent.
          batcher.enqueue({
            type: "trace-upsert",
            body: {
              id,
              timestamp,
              ...(startOptions.name && { name: startOptions.name }),
              ...(startOptions.userId && { userId: startOptions.userId }),
              ...(startOptions.sessionId && { sessionId: startOptions.sessionId }),
              ...(startOptions.environment && { environment: startOptions.environment }),
              ...(startOptions.release && { release: startOptions.release }),
              ...(startOptions.version && { version: startOptions.version }),
              tags: startOptions.tags ?? [],
              ...(startOptions.input !== undefined && { input: startOptions.input }),
              ...(updateOptions.output !== undefined && { output: updateOptions.output }),
              metadata: { ...startOptions.metadata, ...updateOptions.metadata }
            }
          });
        },
        score: (scoreOptions: ScoreOptions) => enqueueScore(id, undefined, scoreOptions)
      };
    },
    flush: () => batcher.flush(),
    shutdown: () => batcher.close()
  };
}
