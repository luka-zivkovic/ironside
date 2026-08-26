import { describe, expect, it } from "vitest";
import { assertPublicHttpDestination } from "../src/lib/ssrf-guard.js";

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
