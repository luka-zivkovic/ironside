import { lookup as lookupCallback, type LookupAddress, type LookupAllOptions, type LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

/**
 * Blocks server-side requests to a customer-supplied URL from reaching
 * loopback/link-local/private/internal network ranges. Webhook and OTLP
 * forward rules send to a URL a project admin can set via the API, so
 * without this check the worker is a general-purpose SSRF proxy into
 * whatever network it runs on (cloud metadata endpoints, internal admin
 * panels, other services on the same private network). S3 export endpoints
 * and the LangFuse and LangSmith import base URLs are not guarded: they
 * commonly point at self-hosted services on a private network (the bundled
 * MinIO, a self-hosted LangFuse).
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
  const isBlocked = options.isBlockedAddress ?? isPrivateOrReservedAddress;
  const connector = buildConnector({ lookup: createGuardedLookup(options), allowH2: false });
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

/**
 * The `lookup` a guarded socket connects with: resolves the hostname once,
 * refuses the whole answer when any address in it is refused, and otherwise
 * answers with those same addresses, as a list or as the first one,
 * depending on what the caller asked for (`all`; Node asks for a list when
 * it tries several addresses in turn).
 */
export function createGuardedLookup(
  options: GuardedFetchOptions = {}
): (hostname: string, lookupOptions: LookupOptions, callback: LookupCallback) => void {
  const lookupAll: LookupAll =
    options.lookupAll ?? ((hostname, lookupOptions, callback) => lookupCallback(hostname, lookupOptions, callback));
  const isBlocked = options.isBlockedAddress ?? isPrivateOrReservedAddress;
  return (hostname, lookupOptions, callback) => {
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
}

/**
 * The fetch webhook and OTLP forward deliveries use: see createGuardedFetch.
 * It connects directly, ignoring HTTP_PROXY and NODE_USE_ENV_PROXY, since a
 * proxy would make the connection-time check meaningless.
 */
export const publicFetch: typeof fetch = createGuardedFetch();

/**
 * publicFetch's transport with no address refused: what the runners send
 * with under their test-only `allowPrivateDestinations`, so tests against a
 * local server exercise the same fetch as production.
 */
export const anyAddressFetch: typeof fetch = createGuardedFetch({ isBlockedAddress: () => false });

/**
 * IPv4 ranges that are not globally reachable (the IANA special-purpose
 * address registry), plus multicast and the reserved block.
 */
const BLOCKED_IPV4 = blockList("ipv4", [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space: carrier-grade NAT, some clouds' metadata (100.100.100.200)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including the cloud metadata address 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4] // reserved, including broadcast
]);

/** IPv6 ranges that are not globally reachable. Forms embedding an IPv4 address are checked by that address. */
const BLOCKED_IPV6 = blockList("ipv6", [
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["100:0:0:1::", 64], // dummy prefix
  ["2001::", 23], // IETF protocol assignments, including Teredo and benchmarking
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation
  ["5f00::", 16], // SRv6 segment identifiers
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8] // multicast
]);

function blockList(type: "ipv4" | "ipv6", subnets: [string, number][]): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of subnets) list.addSubnet(network, prefix, type);
  return list;
}

/** Whether a connection to `address` is refused. Anything that is not an IP address is refused too. */
export function isPrivateOrReservedAddress(address: string): boolean {
  const unzoned = address.split("%")[0]!;
  const family = isIP(unzoned);
  if (family === 4) return BLOCKED_IPV4.check(unzoned, "ipv4");
  if (family !== 6) return true;
  const embedded = embeddedIpv4(ipv6Bytes(unzoned));
  if (embedded !== undefined) return BLOCKED_IPV4.check(embedded, "ipv4");
  return BLOCKED_IPV6.check(unzoned, "ipv6");
}

/**
 * The IPv4 address an IPv6 address carries, for the forms that route to it:
 * IPv4-mapped (::ffff:0:0/96), IPv4-translated (::ffff:0:0:0/96),
 * IPv4-compatible (::/96, which makes :: and ::1 into 0.0.0.0 and 0.0.0.1,
 * both refused), NAT64 (64:ff9b::/96) and 6to4 (2002::/16).
 */
function embeddedIpv4(bytes: number[]): string | undefined {
  const zero = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  const ipv4 = (from: number) => bytes.slice(from, from + 4).join(".");
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return ipv4(12);
  if (zero(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zero(10, 12)) return ipv4(12);
  if (zero(0, 12)) return ipv4(12);
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)) return ipv4(12);
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return ipv4(2);
  return undefined;
}

/** The 16 bytes of a valid IPv6 address, in any of its textual forms. */
function ipv6Bytes(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const groups = (part: string) => (part === "" ? [] : part.split(":").map((group) => Number.parseInt(group, 16)));
  const [head = "", tail] = text.split("::");
  const words =
    tail === undefined
      ? groups(head)
      : [...groups(head), ...new Array<number>(8 - groups(head).length - groups(tail).length).fill(0), ...groups(tail)];
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}
