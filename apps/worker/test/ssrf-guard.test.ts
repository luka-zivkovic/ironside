import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  NonPublicAddressError,
  assertPublicHttpDestination,
  createGuardedFetch,
  createGuardedLookup,
  isPrivateOrReservedAddress,
  publicFetch,
  type GuardedFetchOptions
} from "../src/lib/ssrf-guard.js";

describe("assertPublicHttpDestination", () => {
  it("rejects an explicit loopback IPv4 URL", async () => {
    await expect(assertPublicHttpDestination("http://127.0.0.1/hook")).rejects.toThrow(
      /non-public address/
    );
  });

  it("rejects the cloud metadata address", async () => {
    await expect(assertPublicHttpDestination("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /non-public address/
    );
  });

  it("rejects private IPv4 ranges (10/8, 172.16/12, 192.168/16)", async () => {
    await expect(assertPublicHttpDestination("http://10.0.0.5/hook")).rejects.toThrow(
      /non-public address/
    );
    await expect(assertPublicHttpDestination("http://172.20.1.1/hook")).rejects.toThrow(
      /non-public address/
    );
    await expect(assertPublicHttpDestination("http://192.168.1.1/hook")).rejects.toThrow(
      /non-public address/
    );
  });

  it("rejects an IPv6 loopback URL", async () => {
    await expect(assertPublicHttpDestination("http://[::1]/hook")).rejects.toThrow(
      /non-public address/
    );
  });

  it("rejects the IPv6 unspecified address", async () => {
    await expect(assertPublicHttpDestination("http://[::]/hook")).rejects.toThrow(
      /non-public address/
    );
  });

  it("rejects IPv4-mapped IPv6 addresses across every private range, not just 10/8", async () => {
    await expect(assertPublicHttpDestination("http://[::ffff:172.20.1.1]/hook")).rejects.toThrow(
      /non-public address/
    );
    await expect(assertPublicHttpDestination("http://[::ffff:192.168.1.1]/hook")).rejects.toThrow(
      /non-public address/
    );
    await expect(assertPublicHttpDestination("http://[::ffff:127.0.0.1]/hook")).rejects.toThrow(
      /non-public address/
    );
  });

  it("allows an IPv4-mapped IPv6 address whose embedded IPv4 is public", async () => {
    await expect(assertPublicHttpDestination("http://[::ffff:8.8.8.8]/hook")).resolves.toBeUndefined();
  });

  it("rejects a non-http(s) protocol", async () => {
    await expect(assertPublicHttpDestination("file:///etc/passwd")).rejects.toThrow(
      /must be http or https/
    );
  });

  it("resolves and rejects a hostname that resolves to localhost", async () => {
    await expect(assertPublicHttpDestination("http://localhost/hook")).rejects.toThrow(
      /non-public address/
    );
  });

  it("allows a public IPv4 address", async () => {
    await expect(assertPublicHttpDestination("https://8.8.8.8/hook")).resolves.toBeUndefined();
  });

  it("refuses URL forms of IPv4 that the URL parser turns into a private address", async () => {
    for (const url of ["http://2130706433/", "http://0x7f.1/", "http://127.1/", "http://0177.0.0.1/", "http://0/"]) {
      await expect(assertPublicHttpDestination(url), url).rejects.toThrow(/non-public address/);
    }
  });
});

describe("isPrivateOrReservedAddress", () => {
  it("refuses every IPv4 range that is not globally reachable", () => {
    for (const address of [
      "0.1.2.3",
      "10.255.0.1",
      "100.64.0.1",
      "100.100.100.200", // a cloud metadata service in the shared address space
      "100.127.255.255",
      "127.0.0.53",
      "169.254.169.254",
      "172.31.255.255",
      "192.0.0.8",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.0.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "239.255.255.250",
      "240.0.0.1",
      "255.255.255.255"
    ]) {
      expect(isPrivateOrReservedAddress(address), address).toBe(true);
    }
    for (const address of ["1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.32.0.1", "198.20.0.1", "223.255.255.255"]) {
      expect(isPrivateOrReservedAddress(address), address).toBe(false);
    }
  });

  it("refuses IPv6 ranges that are not globally reachable, across the whole prefix", () => {
    for (const address of [
      "::",
      "::1",
      "fe80::1",
      "fe81::1",
      "febf:ffff::1",
      "fec0::1",
      "fc00::1",
      "fdff::1",
      "ff02::1",
      "100::1",
      "2001::1", // Teredo
      "2001:db8::1",
      "3fff::1",
      "3fff:fff:ffff::1",
      "5f00::1",
      "100:0:0:1::1",
      "64:ff9b:1::1",
      "fe80::1%en0"
    ]) {
      expect(isPrivateOrReservedAddress(address), address).toBe(true);
    }
    for (const address of ["2606:4700:4700::1111", "2a00:1450:4001::200e", "2001:200::1", "3fff:1000::1", "5f01::1"]) {
      expect(isPrivateOrReservedAddress(address), address).toBe(false);
    }
  });

  it("judges an IPv6 address that carries an IPv4 address by that address", () => {
    // Mapped, translated, compatible (in the hex form the URL parser produces), NAT64 and 6to4.
    for (const address of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:0:7f00:1",
      "::7f00:1",
      "::127.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b::10.0.0.1",
      "2002:a9fe:a9fe::1",
      "2002:c0a8:101::"
    ]) {
      expect(isPrivateOrReservedAddress(address), address).toBe(true);
    }
    // The same forms around a public address stay reachable, so NAT64 and 6to4 still work.
    for (const address of ["::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1"]) {
      expect(isPrivateOrReservedAddress(address), address).toBe(false);
    }
  });

  it("refuses anything that is not an IP address", () => {
    expect(isPrivateOrReservedAddress("localhost")).toBe(true);
    expect(isPrivateOrReservedAddress("")).toBe(true);
  });
});

describe("createGuardedLookup", () => {
  const answer = (...addresses: string[]): NonNullable<GuardedFetchOptions["lookupAll"]> => (_hostname, _options, callback) =>
    callback(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
  const call = (lookup: ReturnType<typeof createGuardedLookup>, all: boolean) =>
    new Promise<{ error: unknown; address: unknown; family: unknown }>((resolve) =>
      lookup("hooks.example.com", { all }, (error, address, family) => resolve({ error, address, family }))
    );

  it("answers a single-address lookup with the first address and a list lookup with all of them", async () => {
    const lookup = createGuardedLookup({ lookupAll: answer("8.8.8.8", "2001:4860:4860::8888") });
    expect(await call(lookup, false)).toEqual({ error: null, address: "8.8.8.8", family: 4 });
    expect(await call(lookup, true)).toEqual({
      error: null,
      address: [
        { address: "8.8.8.8", family: 4 },
        { address: "2001:4860:4860::8888", family: 6 }
      ],
      family: undefined
    });
  });

  it("refuses the whole answer for either kind of lookup when one address is private", async () => {
    const lookup = createGuardedLookup({ lookupAll: answer("8.8.8.8", "169.254.169.254") });
    for (const all of [false, true]) {
      const { error } = await call(lookup, all);
      expect(error).toBeInstanceOf(NonPublicAddressError);
      expect((error as Error).message).toMatch(/169\.254\.169\.254/);
    }
  });

  it("reports an empty answer as not found", async () => {
    const { error } = await call(createGuardedLookup({ lookupAll: answer() }), false);
    expect(error).toMatchObject({ code: "ENOTFOUND" });
  });
});

describe("publicFetch: the address is checked when the connection is made", () => {
  let server: Server;
  let port: number;
  let requests: { method: string; url: string; body: string; host: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        requests.push({ method: req.method!, url: req.url!, body, host: req.headers.host! });
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
          return;
        }
        res.writeHead(202, { "content-type": "text/plain" }).end("accepted");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    requests = [];
  });

  /** A resolver that answers every hostname with `addresses`, as a rebinding DNS server would at connect time. */
  const answering =
    (...addresses: string[]): NonNullable<GuardedFetchOptions["lookupAll"]> =>
    (_hostname, _options, callback) =>
      callback(
        null,
        addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))
      );
  const post = (fetchImpl: typeof fetch, url: string) =>
    fetchImpl(url, { method: "POST", body: "{}", redirect: "manual", signal: AbortSignal.timeout(1_000) });

  it("refuses a hostname that resolves to a private address at connect time, sending nothing", async () => {
    // The guard's own resolution could have seen a public address; this answer is the one connected to.
    const rebound = createGuardedFetch({ lookupAll: answering("127.0.0.1") });
    const error = await post(rebound, `http://hooks.example.com:${port}/hook`).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NonPublicAddressError);
    expect((error as Error).message).toMatch(/non-public address: 127\.0\.0\.1/);
    // An https URL connects through tls.connect, which takes the same lookup.
    await expect(post(rebound, `https://hooks.example.com:${port}/hook`)).rejects.toThrow(NonPublicAddressError);
    expect(requests).toEqual([]);
  });

  it("refuses the whole answer when any address in it is private", async () => {
    // 8.8.8.8 is public, and never reached: the answer is refused before connecting.
    const mixed = createGuardedFetch({ lookupAll: answering("8.8.8.8", "10.0.0.7") });
    await expect(post(mixed, `http://hooks.example.com:${port}/hook`)).rejects.toThrow(/non-public address: 10\.0\.0\.7/);
    const mapped = createGuardedFetch({ lookupAll: answering("::ffff:169.254.169.254") });
    await expect(post(mapped, `http://hooks.example.com:${port}/hook`)).rejects.toThrow(NonPublicAddressError);
  });

  it("refuses an address written in the URL, which is never resolved", async () => {
    await expect(post(publicFetch, `http://127.0.0.1:${port}/hook`)).rejects.toThrow(/non-public address: 127\.0\.0\.1/);
    await expect(post(publicFetch, `http://[::1]:${port}/hook`)).rejects.toThrow(/non-public address: ::1/);
    await expect(post(publicFetch, `http://localhost:${port}/hook`)).rejects.toThrow(NonPublicAddressError);
    expect(requests).toEqual([]);
  });

  it("delivers to the checked address, keeping the hostname, the response, and manual redirects", async () => {
    // Only the address policy is relaxed, so the request can reach the local server.
    const allowLoopback = createGuardedFetch({
      lookupAll: answering("127.0.0.1"),
      isBlockedAddress: (address) => address !== "127.0.0.1"
    });
    const response = await post(allowLoopback, `http://hooks.example.com:${port}/hook`);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("accepted");
    expect(requests).toEqual([{ method: "POST", url: "/hook", body: "{}", host: `hooks.example.com:${port}` }]);

    const redirect = await post(allowLoopback, `http://hooks.example.com:${port}/redirect`);
    expect(redirect.status).toBe(302);
    await redirect.body?.cancel();
    expect(requests.map((request) => request.url)).toEqual(["/hook", "/redirect"]);
  });

  it("passes a resolver error through", async () => {
    const failing = createGuardedFetch({
      lookupAll: (hostname, _options, callback) =>
        callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), [])
    });
    const error = await post(failing, `http://missing.example.com:${port}/hook`).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(NonPublicAddressError);
    expect(String((error as Error).cause)).toMatch(/ENOTFOUND/);
  });
});
