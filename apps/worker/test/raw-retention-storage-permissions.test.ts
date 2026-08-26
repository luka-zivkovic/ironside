import type { ObjectStorage } from "@ironside/storage";
import { describe, expect, it, vi } from "vitest";
import { verifyRawRetentionStorage } from "../src/retention/storage-permissions.js";

function storage(deleteImpl: (key: string, values: Set<string>) => Promise<void>) {
  const values = new Set<string>();
  return {
    putJson: vi.fn(async (key: string) => {
      values.add(key);
    }),
    exists: vi.fn(async (key: string) => values.has(key)),
    delete: vi.fn(async (key: string) => deleteImpl(key, values))
  } as unknown as ObjectStorage;
}

describe("raw retention storage permissions", () => {
  it("proves delete on a reserved non-canonical raw key", async () => {
    const candidate = storage(async (key, values) => {
      values.delete(key);
    });

    await expect(
      verifyRawRetentionStorage(candidate, ["raw/proj_1/2025/01/01/batch.json"])
    ).resolves.not.toThrow();
    expect(candidate.putJson).toHaveBeenCalledWith(
      expect.stringMatching(
        /^raw\/proj_1\/2025\/01\/01\/\.retention-probes\/.+\.json$/
      ),
      { probe: "raw-retention-delete" }
    );
  });

  it("does not mistake an internal-only permission for target-day delete access", async () => {
    const candidate = storage(async (key, values) => {
      if (key.startsWith("raw/.internal/")) {
        values.delete(key);
        return;
      }
      throw new Error("AccessDenied on canonical project prefix");
    });

    await expect(
      verifyRawRetentionStorage(candidate, ["raw/proj_1/2025/01/01/batch.json"])
    ).rejects.toThrow("target-day probe prefix raw/proj_1/2025/01/01/");
  });
});
