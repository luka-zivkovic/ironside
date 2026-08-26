import type { ObjectStorage } from "@ironside/storage";
import { parseRawObjectKey } from "@ironside/shared";
import { ulid } from "ulid";

/**
 * Verifies destructive permission inside every reviewed target-day prefix
 * before any intent is claimed. The extra directory makes each probe
 * noncanonical while exercising the same ordinary project/date IAM scope.
 */
export async function verifyRawRetentionStorage(
  storage: ObjectStorage,
  objectKeys: string[]
): Promise<void> {
  const prefixes = new Set<string>();
  for (const objectKey of objectKeys) {
    if (!parseRawObjectKey(objectKey)) {
      throw new Error(`cannot probe invalid raw retention object key ${objectKey}`);
    }
    prefixes.add(objectKey.slice(0, objectKey.lastIndexOf("/") + 1));
  }

  for (const prefix of prefixes) {
    const key = `${prefix}.retention-probes/${ulid()}.json`;
    try {
      await storage.putJson(key, { probe: "raw-retention-delete" });
      if (!(await storage.exists(key))) {
        throw new Error("raw retention storage probe was not readable after write");
      }
      await storage.delete(key);
      if (await storage.exists(key)) {
        throw new Error("raw retention storage probe still exists after delete");
      }
    } catch (error) {
      try {
        await storage.delete(key);
      } catch {
        // Preserve the original permission error; the reserved probe may need
        // manual cleanup when delete permission itself is what failed.
      }
      throw new Error(
        `raw retention execution requires PutObject, HeadObject, and DeleteObject on target-day probe prefix ${prefix}.retention-probes/* and DeleteObject on reviewed raw objects`,
        { cause: error }
      );
    }
  }
}
