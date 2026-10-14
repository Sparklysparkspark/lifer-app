import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { globalRateLimitKey, registerRateLimit } from "./rateLimit.js";

async function appWithLimit(perMinute: number) {
  const app = Fastify();
  await registerRateLimit(app, perMinute);
  app.get("/ping", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("registerRateLimit", () => {
  it("refuses an address past its limit, with Retry-After", async () => {
    const app = await appWithLimit(2);
    expect((await app.inject("/ping")).statusCode).toBe(200);
    expect((await app.inject("/ping")).statusCode).toBe(200);
    const refused = await app.inject("/ping");
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("counts addresses separately", async () => {
    const app = await appWithLimit(1);
    expect((await app.inject({ url: "/ping", remoteAddress: "192.0.2.1" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/ping", remoteAddress: "192.0.2.2" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/ping", remoteAddress: "192.0.2.1" })).statusCode).toBe(429);
    await app.close();
  });

  it("counts an IPv6 /64 as one address", async () => {
    const app = await appWithLimit(1);
    expect((await app.inject({ url: "/ping", remoteAddress: "2001:db8:1:2::1" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/ping", remoteAddress: "2001:db8:1:2::ffff" })).statusCode).toBe(429);
    expect((await app.inject({ url: "/ping", remoteAddress: "2001:db8:1:3::1" })).statusCode).toBe(200);
    await app.close();
  });

  it("counts LAN IPv6 hosts separately", async () => {
    const app = await appWithLimit(1);
    expect((await app.inject({ url: "/ping", remoteAddress: "fe80::1" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/ping", remoteAddress: "fe80::2" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/ping", remoteAddress: "fd00:1:2:3::1" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/ping", remoteAddress: "fd00:1:2:3::2" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/ping", remoteAddress: "fe80::1" })).statusCode).toBe(429);
    await app.close();
  });

  it("is off at 0", async () => {
    const app = await appWithLimit(0);
    for (let i = 0; i < 5; i++) expect((await app.inject("/ping")).statusCode).toBe(200);
    await app.close();
  });
});

describe("globalRateLimitKey", () => {
  it("groups only global unicast IPv6 by /64", () => {
    expect(globalRateLimitKey("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(globalRateLimitKey("3fff::1")).toBe("3fff:0:0:0::/64");
    expect(globalRateLimitKey("fe80::1%eth0")).toBe("fe80::1%eth0");
    expect(globalRateLimitKey("FD12::1")).toBe("fd12::1");
    expect(globalRateLimitKey("::1")).toBe("::1");
  });

  it("keys IPv4 and mapped IPv4 by address", () => {
    expect(globalRateLimitKey("203.0.113.9")).toBe("203.0.113.9");
    expect(globalRateLimitKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(globalRateLimitKey("::ffff:cb00:7109")).toBe("::ffff:cb00:7109");
    expect(globalRateLimitKey("64:ff9b::203.0.113.9")).toBe("64:ff9b::203.0.113.9");
  });
});
