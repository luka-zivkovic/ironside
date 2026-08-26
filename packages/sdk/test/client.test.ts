import { afterEach, describe, expect, it, vi } from "vitest";
import { init } from "../src/client.js";
import type { IngestRequestEvent } from "../src/types.js";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: { events: IngestRequestEvent[] };
}

function mockFetch() {
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
    requests.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body))
    });
    return new Response("{}", { status: 202 });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function failingFetch(status: number) {
  return vi.fn(async () => new Response("error", { status })) as unknown as typeof fetch;
}

describe("Ironside SDK client", () => {
  const clients: { shutdown: () => Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.shutdown()));
  });

  it("sends a trace-upsert on trace(), authenticated with the configured api key", async () => {
    const { fetchImpl, requests } = mockFetch();
    const client = init({ apiKey: "ironside_sc_test", host: "http://localhost:8788", fetchImpl });
    clients.push(client);

    const trace = client.trace({ name: "checkout", userId: "user_1", tags: ["prod"] });
    await client.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://localhost:8788/api/v1/ingest");
    expect(requests[0]?.headers.authorization).toBe("Bearer ironside_sc_test");
    const event = requests[0]?.body.events[0];
    expect(event?.type).toBe("trace-upsert");
    expect(event?.body).toMatchObject({
      id: trace.id,
      name: "checkout",
      userId: "user_1",
      tags: ["prod"]
    });
  });

  it("nests span/generation observations correctly and sends end() as an updated upsert", async () => {
    const { fetchImpl, requests } = mockFetch();
    const client = init({ apiKey: "k", host: "http://localhost:8788", fetchImpl });
    clients.push(client);

    const trace = client.trace({ name: "chat" });
    const root = trace.span({ name: "handle-request" });
    const gen = root.generation({ name: "llm-call", model: "gpt-4o" });
    gen.end({ output: { text: "hi" }, usageDetails: { input_tokens: 10, output_tokens: 5 } });
    root.end();
    await client.flush();

    const events = requests.flatMap((r) => r.body.events);
    const genEvents = events.filter(
      (e) => (e.body as { id: string }).id === gen.id
    );
    // start + end = 2 observation-upsert events for the same id; the
    // worker's ReplacingMergeTree upsert makes the end() write win.
    expect(genEvents).toHaveLength(2);
    const finalGen = genEvents[1]?.body as {
      parentObservationId: string;
      model: string;
      endTime: string;
      usageDetails: Record<string, number>;
    };
    expect(finalGen.parentObservationId).toBe(root.id);
    expect(finalGen.model).toBe("gpt-4o");
    expect(finalGen.endTime).toBeTruthy();
    expect(finalGen.usageDetails).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("trace.update() preserves the original timestamp rather than re-stamping it", async () => {
    const { fetchImpl, requests } = mockFetch();
    const client = init({ apiKey: "k", host: "http://localhost:8788", fetchImpl });
    clients.push(client);

    const trace = client.trace({ name: "checkout" });
    await client.flush();
    const firstTimestamp = (requests[0]?.body.events[0]?.body as { timestamp: string }).timestamp;

    trace.update({ output: { total: 42 } });
    await client.flush();
    const secondTimestamp = (requests[1]?.body.events[0]?.body as { timestamp: string })
      .timestamp;

    expect(secondTimestamp).toBe(firstTimestamp);
  });

  it("trace.update() does not wipe name/userId/sessionId/input set by trace() — regression: a trace-upsert replaces the whole row (ClickHouse has no field-level merge), so update() must carry every field forward, not just the ones it's changing", async () => {
    const { fetchImpl, requests } = mockFetch();
    const client = init({ apiKey: "k", host: "http://localhost:8788", fetchImpl });
    clients.push(client);

    const trace = client.trace({
      name: "checkout",
      userId: "user_1",
      sessionId: "sess_1",
      input: { cart: ["sku_1"] }
    });
    trace.update({ output: { total: 42 } });
    await client.flush();

    const events = requests.flatMap((r) => r.body.events);
    const updateEvent = events[events.length - 1]?.body as {
      name?: string;
      userId?: string;
      sessionId?: string;
      input?: unknown;
      output?: unknown;
    };
    expect(updateEvent.name).toBe("checkout");
    expect(updateEvent.userId).toBe("user_1");
    expect(updateEvent.sessionId).toBe("sess_1");
    expect(updateEvent.input).toEqual({ cart: ["sku_1"] });
    expect(updateEvent.output).toEqual({ total: 42 });
  });

  it("batches multiple events into a single request when flushed together", async () => {
    const { fetchImpl, requests } = mockFetch();
    const client = init({
      apiKey: "k",
      host: "http://localhost:8788",
      fetchImpl,
      flushIntervalMs: 60_000
    });
    clients.push(client);

    const trace = client.trace({ name: "batch-test" });
    trace.span({ name: "a" }).end();
    trace.span({ name: "b" }).end();
    await client.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.events.length).toBeGreaterThanOrEqual(3);
  });

  it("auto-flushes once maxBatchSize is reached, without an explicit flush() call", async () => {
    const { fetchImpl, requests } = mockFetch();
    const client = init({
      apiKey: "k",
      host: "http://localhost:8788",
      fetchImpl,
      maxBatchSize: 2,
      flushIntervalMs: 60_000
    });
    clients.push(client);

    client.trace({ name: "t1" });
    client.trace({ name: "t2" });
    // Give the fire-and-forget flush a tick to complete.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(requests.length).toBeGreaterThanOrEqual(1);
  });

  it("reports failures via onError instead of throwing back into the caller", async () => {
    const onError = vi.fn();
    const client = init({
      apiKey: "k",
      host: "http://localhost:8788",
      fetchImpl: failingFetch(500),
      onError
    });
    clients.push(client);

    client.trace({ name: "will-fail" });
    await expect(client.flush()).resolves.not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("reports network-level failures (fetch throwing) via onError too", async () => {
    const onError = vi.fn();
    const throwingFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = init({
      apiKey: "k",
      host: "http://localhost:8788",
      fetchImpl: throwingFetch,
      onError
    });
    clients.push(client);

    client.trace({ name: "will-fail" });
    await expect(client.flush()).resolves.not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("shutdown() flushes remaining buffered events and stops the timer", async () => {
    const { fetchImpl, requests } = mockFetch();
    const client = init({
      apiKey: "k",
      host: "http://localhost:8788",
      fetchImpl,
      flushIntervalMs: 60_000
    });

    client.trace({ name: "final" });
    await client.shutdown();

    expect(requests).toHaveLength(1);
  });

  it("shutdown() waits for an already-in-flight send instead of racing ahead of it (regression: a batch could be silently dropped if the process exited right after shutdown() resolved while a request was still pending)", async () => {
    const sent: unknown[] = [];
    let resolveSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const slowFetch: typeof fetch = vi.fn(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      await sendGate; // held open until the test explicitly releases it
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;

    const client = init({
      apiKey: "k",
      host: "http://localhost:8788",
      fetchImpl: slowFetch,
      maxBatchSize: 1,
      flushIntervalMs: 60_000
    });

    // Hits maxBatchSize=1, triggering an auto-flush whose send() is now
    // blocked on sendGate — buffer is already empty by the time close()
    // gets a chance to run, mirroring the real race.
    client.trace({ name: "will-be-in-flight" });
    await Promise.resolve(); // let the auto-flush's synchronous claim run

    let shutdownResolved = false;
    const shutdownPromise = client.shutdown().then(() => {
      shutdownResolved = true;
    });

    // shutdown() must NOT resolve while the send is still gated.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shutdownResolved).toBe(false);
    expect(sent).toHaveLength(1);

    resolveSend();
    await shutdownPromise;
    expect(shutdownResolved).toBe(true);
  });

  it("trace() carries environment/release/version through both the initial upsert and update()", async () => {
    const { fetchImpl, requests } = mockFetch();
    const client = init({ apiKey: "k", host: "http://localhost:8788", fetchImpl });
    clients.push(client);

    const trace = client.trace({
      name: "checkout",
      environment: "production",
      release: "1.4.0",
      version: "abc123"
    });
    trace.update({ output: { total: 42 } });
    await client.flush();

    const events = requests.flatMap((r) => r.body.events);
    for (const event of events) {
      const body = event.body as { environment?: string; release?: string; version?: string };
      expect(body.environment).toBe("production");
      expect(body.release).toBe("1.4.0");
      expect(body.version).toBe("abc123");
    }
  });

  it("trace.score() sends a score-upsert scoped to the trace, with no observationId", async () => {
    const { fetchImpl, requests } = mockFetch();
    const client = init({ apiKey: "k", host: "http://localhost:8788", fetchImpl });
    clients.push(client);

    const trace = client.trace({ name: "checkout" });
    trace.score({ name: "thumbs-up", value: 1, comment: "great answer" });
    await client.flush();

    const scoreEvent = requests
      .flatMap((r) => r.body.events)
      .find((e) => e.type === "score-upsert");
    expect(scoreEvent).toBeTruthy();
    const body = scoreEvent?.body as {
      traceId: string;
      observationId?: string;
      name: string;
      dataType: string;
      value: number;
      source: string;
      comment: string;
      timestamp: string;
    };
    expect(body.traceId).toBe(trace.id);
    expect(body.observationId).toBeUndefined();
    expect(body.name).toBe("thumbs-up");
    expect(body.dataType).toBe("numeric");
    expect(body.value).toBe(1);
    expect(body.source).toBe("api");
    expect(body.comment).toBe("great answer");
    expect(body.timestamp).toBeTruthy();
  });

  it("observation.score() sends a score-upsert scoped to that observation, defaulting dataType to categorical when stringValue is used", async () => {
    const { fetchImpl, requests } = mockFetch();
    const client = init({ apiKey: "k", host: "http://localhost:8788", fetchImpl });
    clients.push(client);

    const trace = client.trace({ name: "checkout" });
    const gen = trace.generation({ name: "llm-call" });
    gen.score({ name: "quality", stringValue: "good", source: "eval" });
    await client.flush();

    const scoreEvent = requests
      .flatMap((r) => r.body.events)
      .find((e) => e.type === "score-upsert");
    const body = scoreEvent?.body as {
      traceId: string;
      observationId: string;
      dataType: string;
      stringValue: string;
      source: string;
    };
    expect(body.traceId).toBe(trace.id);
    expect(body.observationId).toBe(gen.id);
    expect(body.dataType).toBe("categorical");
    expect(body.stringValue).toBe("good");
    expect(body.source).toBe("eval");
  });

  it("score() preserves a numeric value of 0 — meaningful data, not falsy noise", async () => {
    const { fetchImpl, requests } = mockFetch();
    const client = init({ apiKey: "k", host: "http://localhost:8788", fetchImpl });
    clients.push(client);

    const trace = client.trace({ name: "checkout" });
    trace.score({ name: "thumbs", value: 0 });
    await client.flush();

    const scoreEvent = requests
      .flatMap((r) => r.body.events)
      .find((e) => e.type === "score-upsert");
    const body = scoreEvent?.body as { value: number; dataType: string };
    expect(body.value).toBe(0);
    expect(body.dataType).toBe("numeric");
  });

  it("ScoreOptions rejects (at compile time) a score with neither value nor stringValue, or with both — regression: the domain schema requires exactly one, and a violation used to be silently dropped server-side since SDK ingest is fire-and-forget with no per-event error surfaced back to the caller", async () => {
    const { fetchImpl } = mockFetch();
    const client = init({ apiKey: "k", host: "http://localhost:8788", fetchImpl });
    clients.push(client);
    const trace = client.trace({ name: "checkout" });

    // @ts-expect-error neither value nor stringValue set
    trace.score({ name: "quality" });
    // @ts-expect-error both value and stringValue set
    trace.score({ name: "quality", value: 1, stringValue: "good" });
  });

  it("host with a trailing slash is normalized (no double slash in the request URL)", async () => {
    const { fetchImpl, requests } = mockFetch();
    const client = init({ apiKey: "k", host: "http://localhost:8788/", fetchImpl });
    clients.push(client);

    client.trace({ name: "x" });
    await client.flush();

    expect(requests[0]?.url).toBe("http://localhost:8788/api/v1/ingest");
  });
});

describe("uploadMedia", () => {
  it("POSTs the raw bytes with the content type and returns the ref", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: typeof fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          ref: "ironside://media/01ARZ3NDEKTSV4RRFFQ69G5FAV",
          contentType: "image/png",
          sizeBytes: 3,
          sha256: "abc"
        }),
        { status: 201 }
      );
    }) as unknown as typeof fetch;

    const client = init({ apiKey: "k", host: "http://localhost:8788/", fetchImpl, flushIntervalMs: 60_000 });
    const uploaded = await client.uploadMedia({
      data: new Uint8Array([1, 2, 3]),
      contentType: "image/png"
    });

    expect(uploaded.ref).toBe("ironside://media/01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(calls).toHaveLength(1);
    // Trailing slash on host must not produce a double-slash URL.
    expect(calls[0]!.url).toBe("http://localhost:8788/api/v1/media");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("image/png");
    expect(headers.authorization).toBe("Bearer k");
    expect(calls[0]!.init.body).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("throws with the server error text on a failed upload", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ error: "empty body" }), { status: 400 })) as unknown as typeof fetch;
    const client = init({ apiKey: "k", host: "http://localhost:8788", fetchImpl, flushIntervalMs: 60_000 });
    await expect(
      client.uploadMedia({ data: new Uint8Array([]), contentType: "image/png" })
    ).rejects.toThrow(/media upload failed: 400/);
  });
});
