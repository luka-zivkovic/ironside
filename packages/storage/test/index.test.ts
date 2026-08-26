import { afterEach, describe, expect, it } from "vitest";
import {
  createObjectStorage,
  InvalidJsonObjectError,
  ObjectTooLargeError,
  type ObjectStorage
} from "../src/index.js";

// S3 bucket names are capped at 63 characters — a full UUID (36 chars)
// plus a descriptive prefix easily blows past that, which is a real bug
// this test suite hit once already (InvalidBucketName). Short random
// suffix instead.
function testBucketId(): string {
  return crypto.randomUUID().split("-")[0]!;
}

function testConfig(bucket: string) {
  return {
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9010",
    region: process.env.S3_REGION ?? "us-east-1",
    accessKeyId: process.env.S3_ACCESS_KEY ?? "ironside",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "ironside123",
    bucket
  };
}

const openStorages: ObjectStorage[] = [];
function storage(bucket: string): ObjectStorage {
  const created = createObjectStorage(testConfig(bucket));
  openStorages.push(created);
  return created;
}

afterEach(() => {
  while (openStorages.length > 0) {
    openStorages.pop()?.close();
  }
});

describe("ensureBucket", () => {
  it("creates the bucket when it doesn't exist yet, and is a no-op when called again on the same instance", async () => {
    const bucket = `is-test-${testBucketId()}`;
    const s = storage(bucket);
    await s.ensureBucket();
    await s.ensureBucket(); // second call must not throw

    // Prove the bucket is actually usable now.
    await s.putJson("smoke-test-key", { ok: true });
    expect(await s.getJson("smoke-test-key")).toEqual({ ok: true });
  });

  it("does not throw when the bucket already exists from a DIFFERENT client instance — the real api/worker startup race", async () => {
    // Reproduces the exact bug caught in a real docker-compose fresh-start
    // test: apps/api and apps/worker are separate processes that each
    // construct their own ObjectStorage and independently call
    // ensureBucket() at boot. When both race to create the same
    // not-yet-existing bucket, the loser's CreateBucketCommand fails with
    // BucketAlreadyOwnedByYou (S3-compatible semantics for the same
    // account re-creating its own bucket) — that must be treated as
    // success, not surfaced as an unhandled rejection that crashes the
    // process on every restart against a persistent MinIO volume.
    const bucket = `is-test-race-${testBucketId()}`;
    const first = storage(bucket);
    const second = storage(bucket);

    await first.ensureBucket();
    // `second` is a genuinely separate S3Client/connection, calling
    // ensureBucket() against a bucket `first` already created — this is
    // the "HEAD raced ahead of the other's CREATE, then CREATE fails
    // because it already exists" path, not the same-instance no-op path.
    await expect(second.ensureBucket()).resolves.toBeUndefined();
  });

  it("genuinely concurrent ensureBucket() calls against a brand-new bucket all succeed", async () => {
    // The real docker-compose scenario: multiple processes starting at
    // the same instant, all calling ensureBucket() before any of them
    // has created the bucket yet.
    const bucket = `is-test-conc-${testBucketId()}`;
    const clients = Array.from({ length: 5 }, () => storage(bucket));

    await expect(Promise.all(clients.map((c) => c.ensureBucket()))).resolves.toBeDefined();

    await clients[0]!.putJson("concurrent-smoke-key", { ok: true });
    expect(await clients[0]!.getJson("concurrent-smoke-key")).toEqual({ ok: true });
  });

  it("deletes objects idempotently", async () => {
    const bucket = `is-test-delete-${testBucketId()}`;
    const s = storage(bucket);
    await s.ensureBucket();
    await s.putJson("delete-me", { ok: true });

    await expect(s.exists("delete-me")).resolves.toBe(true);
    await expect(s.delete("delete-me")).resolves.toBeUndefined();
    await expect(s.exists("delete-me")).resolves.toBe(false);
    await expect(s.getJson("delete-me")).rejects.toBeDefined();
    await expect(s.delete("delete-me")).resolves.toBeUndefined();
  });

  it("returns exact object metadata without downloading and null for absence", async () => {
    const bucket = `is-test-stat-${testBucketId()}`;
    const s = storage(bucket);
    await s.ensureBucket();
    await s.putBytes("raw/proj/day/batch.json", new Uint8Array([1, 2, 3]), "application/json");

    await expect(s.stat("raw/proj/day/batch.json")).resolves.toMatchObject({
      key: "raw/proj/day/batch.json",
      sizeBytes: 3
    });
    await expect(s.stat("missing.json")).resolves.toBeNull();
  });

  it("distinguishes malformed JSON from storage transport failures", async () => {
    const bucket = `is-test-invalid-json-${testBucketId()}`;
    const s = storage(bucket);
    await s.ensureBucket();
    await s.putBytes(
      "pending-ingest/bad.json",
      new TextEncoder().encode("{ definitely not json"),
      "application/json"
    );

    await expect(s.getJson("pending-ingest/bad.json")).rejects.toBeInstanceOf(
      InvalidJsonObjectError
    );
  });

  it("rejects oversized JSON from Content-Length before buffering the body", async () => {
    const bucket = `is-test-json-limit-${testBucketId()}`;
    const s = storage(bucket);
    await s.ensureBucket();
    await s.putJson("failed-ingest/large.json", { reason: "too large" });

    await expect(
      s.getJson("failed-ingest/large.json", { maxBytes: 2 })
    ).rejects.toBeInstanceOf(ObjectTooLargeError);
  });
});
