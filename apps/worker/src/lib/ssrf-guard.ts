import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
 * private address (DNS rebinding) is still blocked.
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
      throw new Error(`destination URL resolves to a non-public address: ${address}`);
    }
  }
}

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
