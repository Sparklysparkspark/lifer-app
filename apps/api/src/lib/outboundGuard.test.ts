import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertAllowedTarget,
  guardedDispatcher,
  isRefusedAddress,
  RefusedAddressError,
  viaDispatcher,
} from "./outboundGuard.js";

describe("isRefusedAddress", () => {
  it("refuses loopback, link-local, unspecified and metadata addresses in every spelling", () => {
    for (const a of [
      "127.0.0.1",
      "127.8.9.10",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "169.254.169.254",
      "fe80::1%en0",
      "0.0.0.0",
      "::",
      "fd00:ec2::254",
      "localhost",
    ]) {
      expect([a, isRefusedAddress(a)]).toEqual([a, true]);
    }
  });

  it("allows LAN and public addresses, a home server being the normal target", () => {
    for (const a of [
      "192.168.1.10",
      "10.0.0.5",
      "172.16.0.1",
      "100.64.0.1",
      "203.0.113.9",
      "fd12:3456::1",
      "2001:db8::1",
      "::ffff:192.168.1.10",
    ]) {
      expect([a, isRefusedAddress(a)]).toEqual([a, false]);
    }
  });
});

describe("assertAllowedTarget", () => {
  const resolveTo =
    (...addresses: string[]) =>
    async () =>
      addresses.map((address) => ({ address }));

  it("checks what the name resolves to, not how it's spelled", async () => {
    await expect(
      assertAllowedTarget(new URL("http://nas.home:4000"), resolveTo("192.168.1.10")),
    ).resolves.toBeUndefined();
    await expect(assertAllowedTarget(new URL("http://lifer.example.com"), resolveTo("127.0.0.1"))).rejects.toThrow(
      RefusedAddressError,
    );
    await expect(
      assertAllowedTarget(new URL("http://metadata.google.internal"), resolveTo("169.254.169.254")),
    ).rejects.toThrow(RefusedAddressError);
    // Any refused address among several is enough: the connection could use it.
    await expect(
      assertAllowedTarget(new URL("http://mixed.example"), resolveTo("192.168.1.10", "::1")),
    ).rejects.toThrow(RefusedAddressError);
  });

  it("refuses IP literals without resolving them", async () => {
    const never = async () => {
      throw new Error("resolved");
    };
    await expect(assertAllowedTarget(new URL("http://127.0.0.1:4310"), never)).rejects.toThrow(RefusedAddressError);
    await expect(assertAllowedTarget(new URL("http://[::1]:4000"), never)).rejects.toThrow(RefusedAddressError);
    await expect(assertAllowedTarget(new URL("http://192.168.1.10:4000"), never)).resolves.toBeUndefined();
  });
});

describe("guardedDispatcher", () => {
  let server: Server;
  let port = 0;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function refusal(url: string, dispatcher = guardedDispatcher()): Promise<unknown> {
    try {
      await fetch(url, viaDispatcher(dispatcher));
      return null;
    } catch (err) {
      return (err as Error).cause;
    } finally {
      await dispatcher.close();
    }
  }

  it("refuses a loopback connection before sending the request", async () => {
    hits = 0;
    expect(await refusal(`http://127.0.0.1:${port}/`)).toBeInstanceOf(RefusedAddressError);
    expect(hits).toBe(0);
    // Without the guard the same request goes through, so the refusal above is the guard's.
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
    expect(hits).toBe(1);
  });

  it("refuses a name that resolves to loopback only when connecting (DNS rebinding)", async () => {
    hits = 0;
    // The early check saw a LAN address; at connect time the name points at loopback.
    await expect(
      assertAllowedTarget(new URL(`http://rebind.test:${port}`), async () => [{ address: "192.168.1.10" }]),
    ).resolves.toBeUndefined();
    const rebound = guardedDispatcher({
      lookup: (_hostname: string, options: object, callback: (...args: never[]) => void) => {
        const cb = callback as unknown as (err: null, address: unknown, family?: number) => void;
        if ((options as { all?: boolean }).all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
        else cb(null, "127.0.0.1", 4);
      },
    });
    expect(await refusal(`http://rebind.test:${port}/`, rebound)).toBeInstanceOf(RefusedAddressError);
    expect(hits).toBe(0);
  });
});
