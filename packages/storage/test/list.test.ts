import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createObjectStorage } from "../src/index.js";

// Unit tests for list() against a stubbed S3Client — unlike index.test.ts
// (which exercises real bucket semantics against MinIO), pagination
// plumbing (ContinuationToken forwarding, lazy page fetching) is protocol
// logic that a stub verifies more precisely, and without docker infra.

interface ListPage {
  Contents?: { Key?: string; Size?: number; LastModified?: Date }[];
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}

function testStorage() {
  return createObjectStorage({
    endpoint: "http://stubbed:9000",
    region: "us-east-1",
    accessKeyId: "stub",
    secretAccessKey: "stub",
    bucket: "stub-bucket"
  });
}

/** Stubs S3Client.send to serve the given ListObjectsV2 pages in order, recording each command's input. */
function stubListPages(pages: ListPage[]) {
  const inputs: {
    Bucket?: string | undefined;
    Prefix?: string | undefined;
    StartAfter?: string | undefined;
    ContinuationToken?: string | undefined;
  }[] = [];
  let call = 0;
  vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
    if (!(command instanceof ListObjectsV2Command)) {
      throw new Error("stub only expects ListObjectsV2Command");
    }
    inputs.push(command.input);
    const page = pages[call];
    call += 1;
    if (!page) throw new Error("stub ran out of pages");
    return page;
  });
  return inputs;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("list", () => {
  it("yields every key under the prefix across paginated responses, in order", async () => {
    const inputs = stubListPages([
      {
        Contents: [{ Key: "raw/p/2026/07/12/a.json" }, { Key: "raw/p/2026/07/12/b.json" }],
        IsTruncated: true,
        NextContinuationToken: "token-1"
      },
      {
        Contents: [{ Key: "raw/p/2026/07/12/c.json" }],
        IsTruncated: false
      }
    ]);

    const storage = testStorage();
    const keys: string[] = [];
    for await (const key of storage.list("raw/p/2026/07/12/")) {
      keys.push(key);
    }

    expect(keys).toEqual([
      "raw/p/2026/07/12/a.json",
      "raw/p/2026/07/12/b.json",
      "raw/p/2026/07/12/c.json"
    ]);
    // Both requests target the configured bucket and prefix; only the
    // second carries the continuation token from the first page.
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ Bucket: "stub-bucket", Prefix: "raw/p/2026/07/12/" });
    expect(inputs[0]?.ContinuationToken).toBeUndefined();
    expect(inputs[1]).toMatchObject({
      Bucket: "stub-bucket",
      Prefix: "raw/p/2026/07/12/",
      ContinuationToken: "token-1"
    });
  });

  it("yields nothing for an empty prefix (Contents absent)", async () => {
    stubListPages([{ IsTruncated: false }]);

    const storage = testStorage();
    const keys: string[] = [];
    for await (const key of storage.list("raw/p/2026/01/01/")) {
      keys.push(key);
    }
    expect(keys).toEqual([]);
  });

  it("forwards startAfter only on the first paginated request", async () => {
    const inputs = stubListPages([
      {
        Contents: [{ Key: "pending-ingest/b.json" }],
        IsTruncated: true,
        NextContinuationToken: "token-1"
      },
      { Contents: [{ Key: "pending-ingest/c.json" }], IsTruncated: false }
    ]);
    const storage = testStorage();

    for await (const _key of storage.list("pending-ingest/", {
      startAfter: "pending-ingest/a.json"
    })) {
      // exhaust both pages
    }

    expect(inputs[0]?.StartAfter).toBe("pending-ingest/a.json");
    expect(inputs[1]?.StartAfter).toBeUndefined();
  });

  it("is lazy: a consumer that stops early never fetches the next page", async () => {
    const inputs = stubListPages([
      {
        Contents: [{ Key: "one" }, { Key: "two" }],
        IsTruncated: true,
        NextContinuationToken: "token-1"
      },
      { Contents: [{ Key: "three" }], IsTruncated: false }
    ]);

    const storage = testStorage();
    for await (const key of storage.list("prefix/")) {
      expect(key).toBe("one");
      break; // caller bails after the first key — e.g. a capped scan
    }
    expect(inputs).toHaveLength(1);
  });

  it("skips entries without a Key rather than yielding undefined", async () => {
    stubListPages([{ Contents: [{ Key: "kept" }, {}], IsTruncated: false }]);

    const storage = testStorage();
    const keys: string[] = [];
    for await (const key of storage.list("prefix/")) {
      keys.push(key);
    }
    expect(keys).toEqual(["kept"]);
  });

  it("exposes size and modification time without downloading object bodies", async () => {
    const lastModified = new Date("2026-08-20T12:00:00.000Z");
    stubListPages([{
      Contents: [{ Key: "raw/p/2026/08/20/a.json", Size: 321, LastModified: lastModified }],
      IsTruncated: false
    }]);
    const storage = testStorage();

    const objects = [];
    for await (const object of storage.listObjects("raw/p/")) objects.push(object);

    expect(objects).toEqual([{
      key: "raw/p/2026/08/20/a.json",
      sizeBytes: 321,
      lastModified
    }]);
  });

});
