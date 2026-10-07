import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "@lifer/core/config.js";

const forwarded = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };

async function seen(raw: string | undefined, remoteAddress: string, headers: Record<string, string> = forwarded) {
  const app = Fastify({ trustProxy: parseTrustProxy(raw) });
  app.get("/", async (r) => ({ ip: r.ip, proto: r.protocol }));
  const res = await app.inject({ url: "/", remoteAddress, headers });
  await app.close();
  return res.json() as { ip: string; proto: string };
}

describe("TRUST_PROXY", () => {
  it("trusts no proxy by default, so a device on the LAN can't pick its own address", async () => {
    expect(await seen(undefined, "127.0.0.1")).toEqual({ ip: "127.0.0.1", proto: "http" });
    expect(await seen("", "172.18.0.5")).toEqual({ ip: "172.18.0.5", proto: "http" });
    expect(await seen(undefined, "192.168.1.20")).toEqual({ ip: "192.168.1.20", proto: "http" });
    expect(await seen(undefined, "198.51.100.7")).toEqual({ ip: "198.51.100.7", proto: "http" });
  });

  it("trusts the proxy addresses or ranges it's given", async () => {
    expect(await seen("192.168.1.5", "192.168.1.5")).toEqual({ ip: "203.0.113.9", proto: "https" });
    expect((await seen("192.168.1.5", "192.168.1.20")).ip).toBe("192.168.1.20");
    expect((await seen("172.16.0.0/12", "172.18.0.5")).ip).toBe("203.0.113.9");
    // The old default, now opt-in by name.
    expect((await seen("loopback,uniquelocal", "192.168.1.20")).ip).toBe("203.0.113.9");
  });

  it("treats a number as a hop count", async () => {
    const twoHops = { "x-forwarded-for": "203.0.113.9, 198.51.100.7", "x-forwarded-proto": "https" };
    expect((await seen("2", "198.51.100.8", twoHops)).ip).toBe("203.0.113.9");
    expect((await seen("1", "198.51.100.8", twoHops)).ip).toBe("198.51.100.7");
  });

  it("can be turned off", async () => {
    expect(await seen("false", "127.0.0.1")).toEqual({ ip: "127.0.0.1", proto: "http" });
  });
});
