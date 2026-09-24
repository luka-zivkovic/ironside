import { lookup as lookupCallback, type LookupAddress, type LookupAllOptions, type LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

/**
 * Blocks server-side requests to a customer-supplied URL from reaching
 * loopback/link-local/private/internal network ranges. Every egress
 * destination in this codebase (webhook rules, OTLP forward rules) is a
 * URL a project admin can set via the API, so without this check the
 * worker is a general-purpose SSRF proxy into whatever network it runs
 * on (cloud metadata endpoints, internal admin panels, other services on
 * the same private network).
 *
 * Resolves the hostname and checks the actual resolved IP(s), not just
 * the hostname string, so a public-looking hostname that resolves to a
 * private address is still blocked. This check runs once, before a run's
 * requests; `publicFetch` checks each connection again, at the address it
 * connects to, so a hostname that re-resolves in between (DNS rebinding)
 * is blocked as well.
 */
export async function assertPublicHttpDestination(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`destination URL must be http or https, got: ${url.protocol}`);
  }

  // URL.hostname keeps the brackets for an IPv6 literal (e.g. "[::1]") —
  // isIP() and dns.lookup() both expect the bracket-free form.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses =
    isIP(hostname) !== 0
      ? [hostname]
      : (await lookup(hostname, { all: true })).map((entry) => entry.address);

  for (const address of addresses) {
    if (isPrivateOrReservedAddress(address)) {
      throw new NonPublicAddressError(address);
    }
  }
}

export class NonPublicAddressError extends Error {
  constructor(address: string) {
    super(`destination URL resolves to a non-public address: ${address}`);
    this.name = "NonPublicAddressError";
  }
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;
type LookupAll = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

export interface GuardedFetchOptions {
  /** Resolves a hostname to all its addresses; `dns.lookup` by default. Tests inject answers. */
  lookupAll?: LookupAll;
  /** Whether a connection to `address` is refused; the private and reserved ranges by default. */
  isBlockedAddress?: (address: string) => boolean;
}

/**
 * A fetch whose connections go only to public addresses. The check runs when
 * the socket connects, on the addresses it connects to: a hostname is
 * resolved once, every address in the answer is checked (one non-public
 * address refuses the connection, as in assertPublicHttpDestination), and
 * the socket connects to those same addresses, so the checked address is the
 * one used. TLS still verifies the certificate against the hostname. An IP
 * address in the URL is checked directly, since it is never resolved.
 *
 * A refused connection rejects with NonPublicAddressError. Pooled
 * connections were checked when they were opened. HTTP/2 stays off, as in
 * Node's built-in fetch. Only string and URL inputs are accepted.
 */
export function createGuardedFetch(options: GuardedFetchOptions = {}): typeof fetch {
  const lookupAll: LookupAll = options.lookupAll ?? ((hostname, lookupOptions, callback) => lookupCallback(hostname, lookupOptions, callback));
  const isBlocked = options.isBlockedAddress ?? isPrivateOrReservedAddress;

  const guardedLookup = (hostname: string, lookupOptions: LookupOptions, callback: LookupCallback): void => {
    lookupAll(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) return callback(error, []);
      const blocked = addresses.find((entry) => isBlocked(entry.address));
      if (blocked) return callback(new NonPublicAddressError(blocked.address), []);
      if (addresses.length === 0) {
        return callback(Object.assign(new Error(`no addresses found for ${hostname}`), { code: "ENOTFOUND" }), []);
      }
      if (lookupOptions.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };

  const connector = buildConnector({ lookup: guardedLookup, allowH2: false });
  const dispatcher = new Agent({
    allowH2: false,
    connect: (connectOptions, callback) => {
      // A literal address is never passed to lookup.
      const literal = connectOptions.hostname.replace(/^\[|\]$/g, "");
      if (isIP(literal) !== 0 && isBlocked(literal)) {
        callback(new NonPublicAddressError(literal), null);
        return;
      }
      connector(connectOptions, callback);
    }
  });

  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new TypeError("publicFetch accepts a URL string or URL only");
    }
    try {
      return (await undiciFetch(input, { ...(init as object), dispatcher } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    } catch (error) {
      // fetch reports every connection failure as "fetch failed"; surface the refusal itself.
      if (error instanceof TypeError && error.cause instanceof NonPublicAddressError) throw error.cause;
      throw error;
    }
  }) as typeof fetch;
}

/** The fetch webhook and OTLP forward deliveries use: see createGuardedFetch. */
export const publicFetch: typeof fetch = createGuardedFetch();

function isPrivateOrReservedIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 127 || // loopback
    a === 10 || // private
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) || // link-local (incl. cloud metadata, 169.254.169.254)
    a === 0 // "this network"
  );
}

function isPrivateOrReservedAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return isPrivateOrReservedIpv4(address);
  }

  const normalized = address.toLowerCase();

  if (normalized === "::" || normalized === "::1") {
    return true; // unspecified / loopback
  }
  if (normalized.startsWith("fe80:")) {
    return true; // link-local
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true; // unique local (fc00::/7)
  }

  // IPv4-mapped/-compatible IPv6 (::ffff:a.b.c.d, or the equivalent
  // ::ffff:xxxx:yyyy hex-group form Node's URL parser canonicalizes it
  // to) embeds a real IPv4 address in the low 32 bits — extract it and
  // re-run the IPv4 check rather than hardcoding per-range prefix
  // strings, which silently miss ranges.
  const embeddedIpv4 = extractEmbeddedIpv4(normalized);
  if (embeddedIpv4) {
    return isPrivateOrReservedIpv4(embeddedIpv4);
  }

  return false;
}

function extractEmbeddedIpv4(normalized: string): string | null {
  const dottedMatch = /^::(ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (dottedMatch) {
    return dottedMatch[2]!;
  }

  // Node's URL parser canonicalizes "::ffff:a.b.c.d" into pure hex-group
  // form, e.g. "::ffff:ac14:101" for "::ffff:172.20.1.1" — decode the
  // trailing two 16-bit hex groups back into the four IPv4 octets.
  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (hexMatch) {
    const high = Number.parseInt(hexMatch[1]!, 16);
    const low = Number.parseInt(hexMatch[2]!, 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }

  return null;
}
