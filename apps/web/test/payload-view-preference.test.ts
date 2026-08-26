import { describe, expect, it } from "vitest";
import {
  payloadViewPreferenceStorageKey,
  readPayloadViewPreference,
  writePayloadViewPreference
} from "../src/lib/payload-view-preference.js";

describe("payload view preference storage", () => {
  it("namespaces the non-secret preference by owner principal", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    };

    writePayloadViewPreference("owner-a", "source", storage);
    writePayloadViewPreference("owner-b", "raw", storage);

    expect(readPayloadViewPreference("owner-a", storage)).toBe("source");
    expect(readPayloadViewPreference("owner-b", storage)).toBe("raw");
    expect(values.get(payloadViewPreferenceStorageKey("owner-a"))).toBe("source");
  });

  it("treats missing or invalid values as automatic mode", () => {
    const storage = { getItem: () => "unexpected" };
    expect(readPayloadViewPreference("owner", storage)).toBeNull();
    expect(readPayloadViewPreference("owner", undefined)).toBeNull();
  });

  it("silently tolerates unavailable browser storage", () => {
    const throwingRead = { getItem: () => { throw new Error("blocked"); } };
    const throwingWrite = { setItem: () => { throw new Error("blocked"); } };

    expect(readPayloadViewPreference("owner", throwingRead)).toBeNull();
    expect(() => writePayloadViewPreference("owner", "rendered", throwingWrite)).not.toThrow();
  });
});
