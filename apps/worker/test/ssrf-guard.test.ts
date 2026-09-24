import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  NonPublicAddressError,
  assertPublicHttpDestination,
  createGuardedFetch,
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
    fetchImpl(url, { method: "POST", body: "{}", redirect: "manual", signal: AbortSignal.timeout(5_000) });

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
    // 192.0.2.1 (TEST-NET-1) is allowed by the policy, and never reached: the answer is refused before connecting.
    const mixed = createGuardedFetch({ lookupAll: answering("192.0.2.1", "10.0.0.7") });
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
