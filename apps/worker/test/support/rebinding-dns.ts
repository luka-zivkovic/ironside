import type * as dns from "node:dns";
import type * as dnsPromises from "node:dns/promises";

/**
 * A hostname that rebinds, as an attacker's DNS server would: the per-run SSRF
 * check (node:dns/promises) resolves it to a public address, and the lookup a
 * connection makes (node:dns) to loopback. A test file mocks both modules with
 * these, and every other hostname resolves normally:
 *
 *   vi.mock("node:dns", async (importOriginal) =>
 *     (await import("./support/rebinding-dns.js")).withRebindingLookup(await importOriginal()));
 */
export const REBINDING_HOST = "rebind.ironside.test";

export function withRebindingLookup(actual: typeof dns): typeof dns {
  const lookup = ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    if (hostname !== REBINDING_HOST) {
      return (actual.lookup as (...args: unknown[]) => void)(hostname, options, callback);
    }
    if ((options as { all?: boolean } | null)?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  }) as typeof actual.lookup;
  return { ...actual, lookup, default: { ...actual, lookup } } as typeof dns;
}

export function withRebindingPromises(actual: typeof dnsPromises): typeof dnsPromises {
  const lookup = ((hostname: string, options?: unknown) =>
    hostname === REBINDING_HOST
      ? Promise.resolve([{ address: "93.184.215.14", family: 4 }])
      : (actual.lookup as (...args: unknown[]) => Promise<unknown>)(hostname, options)) as typeof actual.lookup;
  return { ...actual, lookup, default: { ...actual, lookup } } as typeof dnsPromises;
}
