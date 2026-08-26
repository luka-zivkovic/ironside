import { randomUUID } from "node:crypto";
import {
  FAILED_INGEST_PREFIX,
  PENDING_INGEST_PREFIX,
  PENDING_INGEST_PROBE_PREFIX
} from "@ironside/shared";
import type { ObjectStorage } from "@ironside/storage";

/**
 * Fails worker startup early when the recovery ledger cannot satisfy its
 * prefix-scoped Put/Get/List/Head/Delete contract. Discovering missing DeleteObject
 * only after materializing every batch would turn a permission mistake into a
 * retry storm.
 */
export async function verifyPendingIngestStorage(storage: ObjectStorage): Promise<void> {
  const suffix = `.permission-probe-${randomUUID()}.json`;
  const probes = [
    { key: `${PENDING_INGEST_PROBE_PREFIX}${suffix}`, requireList: true },
    { key: `${FAILED_INGEST_PREFIX}${suffix}`, requireList: false }
  ];
  const created = new Set<string>();
  try {
    for (const probe of probes) {
      await storage.putJson(probe.key, { probe: true });
      created.add(probe.key);

      if (!(await storage.exists(probe.key))) {
        throw new Error(`${probe.key} was not visible to HeadObject`);
      }
      const stored = await storage.getJson(probe.key);
      if (
        typeof stored !== "object" ||
        stored === null ||
        (stored as { probe?: unknown }).probe !== true
      ) {
        throw new Error(`${probe.key} was not readable through GetObject`);
      }
      if (probe.requireList) {
        let listed = false;
        // Use the exact prefix shape used by reconciliation so IAM policies
        // scoped too narrowly to the internal probe cannot pass startup.
        for await (const listedKey of storage.list(PENDING_INGEST_PREFIX)) {
          if (listedKey === probe.key) {
            listed = true;
            break;
          }
        }
        if (!listed) {
          throw new Error(`${probe.key} was not visible to ListObjectsV2`);
        }
      }

      await storage.delete(probe.key);
      created.delete(probe.key);
      if (await storage.exists(probe.key)) {
        throw new Error(`${probe.key} remained after DeleteObject`);
      }
    }
  } catch (error) {
    for (const key of created) await storage.delete(key).catch(() => undefined);
    throw new Error(
      "ingest recovery storage requires PutObject, GetObject/HeadObject, and DeleteObject on pending-ingest/* and failed-ingest/*, plus ListBucket for pending-ingest/*",
      { cause: error }
    );
  }
}
