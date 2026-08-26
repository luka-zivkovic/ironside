import type { ObjectStorage } from "@ironside/storage";
import { describe, expect, it } from "vitest";
import { verifyPendingIngestStorage } from "../src/recovery/storage-permissions.js";

function permissionStorage(
  options: { deleteFails?: boolean; listFailsAfterFirstMatch?: boolean } = {}
) {
  const values = new Map<string, unknown>();
  const calls: string[] = [];
  const storage = {
    async putJson(key: string, value: unknown) {
      calls.push(`put:${key}`);
      values.set(key, value);
    },
    async exists(key: string) {
      calls.push(`head:${key}`);
      return values.has(key);
    },
    async getJson(key: string) {
      calls.push(`get:${key}`);
      return values.get(key);
    },
    async *list(prefix: string) {
      calls.push(`list:${prefix}`);
      for (const key of values.keys()) {
        if (!key.startsWith(prefix)) continue;
        yield key;
        if (options.listFailsAfterFirstMatch) throw new Error("second page fetched");
      }
    },
    async delete(key: string) {
      calls.push(`delete:${key}`);
      if (options.deleteFails) throw new Error("delete denied");
      values.delete(key);
    }
  } as unknown as ObjectStorage;
  return { storage, calls, values };
}

describe("verifyPendingIngestStorage", () => {
  it("proves put, get, head, runtime-prefix list, and delete before startup", async () => {
    const { storage, calls, values } = permissionStorage();

    await expect(verifyPendingIngestStorage(storage)).resolves.toBeUndefined();

    expect(calls.map((entry) => entry.split(":")[0])).toEqual([
      "put",
      "head",
      "get",
      "list",
      "delete",
      "head",
      "put",
      "head",
      "get",
      "delete",
      "head"
    ]);
    expect(calls.find((entry) => entry.startsWith("list:"))).toBe(
      "list:pending-ingest/"
    );
    expect(values.size).toBe(0);
  });

  it("fails startup with an actionable permission error when deletion is denied", async () => {
    const { storage } = permissionStorage({ deleteFails: true });
    const error = await verifyPendingIngestStorage(storage).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("failed-ingest/*");
    expect((error as Error).cause).toMatchObject({ message: "delete denied" });
  });

  it("stops the runtime-prefix list as soon as its probe is found", async () => {
    const { storage } = permissionStorage({ listFailsAfterFirstMatch: true });

    await expect(verifyPendingIngestStorage(storage)).resolves.toBeUndefined();
  });
});
