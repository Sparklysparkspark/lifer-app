import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  globalRateLimitKey,
  IMAGE_LIMIT_FACTOR,
  isImageRequest,
  isStaticAsset,
  isUploadRequest,
  registerRateLimit,
  UPLOAD_LIMIT_FACTOR,
} from "./rateLimit.js";

async function appWithLimit(perMinute: number) {
  const app = Fastify();
  await registerRateLimit(app, perMinute);
  app.get("/ping", async () => ({ ok: true }));
  app.get("/api/photos/:id/thumb", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("registerRateLimit", () => {
  it("counts images apart, under a larger limit, so a fast scroll can't block the rest", async () => {
    const app = await appWithLimit(2);
    for (let i = 0; i < 2 * IMAGE_LIMIT_FACTOR; i++)
      expect((await app.inject(`/api/photos/p${i}/thumb`)).statusCode).toBe(200);
    expect((await app.inject("/api/photos/x/thumb")).statusCode).toBe(429);
    // The shared budget is untouched by all those images.
    expect((await app.inject("/ping")).statusCode).toBe(200);
  });

  it("counts uploads apart, so a 2,000 file import fits in a minute and sign-in stays limited", async () => {
    const app = Fastify();
    await registerRateLimit(app, 3000);
    app.post("/api/uploads/tus", async () => ({ ok: true }));
    app.patch("/api/uploads/tus/:id", async () => ({ ok: true }));
    app.post("/api/uploads/inspect", async () => ({ ok: true }));
    app.post("/api/auth/login", async () => ({ ok: true }));
    await app.ready();
    for (let i = 0; i < 2000; i++) {
      expect((await app.inject({ method: "POST", url: "/api/uploads/tus" })).statusCode).toBe(200);
      expect((await app.inject({ method: "PATCH", url: `/api/uploads/tus/u${i}` })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/uploads/inspect" })).statusCode).toBe(200);
    }
    // 6,000 upload requests left the shared budget whole, and it still ends at the limit.
    for (let i = 0; i < 3000; i++)
      expect((await app.inject({ method: "POST", url: "/api/auth/login" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/login" })).statusCode).toBe(429);
    await app.close();
  }, 60_000);

  it("refuses uploads past their own limit, with Retry-After", async () => {
    const app = Fastify();
    await registerRateLimit(app, 1);
    app.post("/api/uploads/inspect", async () => ({ ok: true }));
    await app.ready();
    for (let i = 0; i < UPLOAD_LIMIT_FACTOR; i++)
      expect((await app.inject({ method: "POST", url: "/api/uploads/inspect" })).statusCode).toBe(200);
    const refused = await app.inject({ method: "POST", url: "/api/uploads/inspect" });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBeDefined();
    await app.close();
  });

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

describe("isStaticAsset", () => {
  it("lets the web app's built files skip the limit, and nothing under /api", () => {
    expect(isStaticAsset("GET", "/assets/index-abc.js")).toBe(true);
    expect(isStaticAsset("HEAD", "/assets/app.css")).toBe(true);
    expect(isStaticAsset("POST", "/assets/x.js")).toBe(false);
    expect(isStaticAsset("GET", "/api/assets/x")).toBe(false);
  });
});

describe("isImageRequest", () => {
  it("is a GET of a photo or card image, not other routes", () => {
    expect(isImageRequest("GET", "/api/species/s1/reference-photo/thumb?v=2")).toBe(true);
    expect(isImageRequest("GET", "/api/photos/p1/card?x=1&y=2&size=3")).toBe(true);
    expect(isImageRequest("GET", "/api/species/reference-gallery-photo/g1/display")).toBe(true);
    expect(isImageRequest("POST", "/api/photos/p1/thumb")).toBe(false);
    expect(isImageRequest("GET", "/api/gallery?q=thumb")).toBe(false);
    expect(isImageRequest("GET", "/api/collection")).toBe(false);
  });
});

describe("isUploadRequest", () => {
  it("is anything under /api/uploads but a GET, not lookalike routes", () => {
    expect(isUploadRequest("PATCH", "/api/uploads/tus/abc")).toBe(true);
    expect(isUploadRequest("HEAD", "/api/uploads/tus/abc")).toBe(true);
    expect(isUploadRequest("POST", "/api/uploads")).toBe(true);
    expect(isUploadRequest("POST", "/api/uploads?skipDuplicates=1")).toBe(true);
    expect(isUploadRequest("POST", "/api/uploads/inspect")).toBe(true);
    expect(isUploadRequest("GET", "/api/uploads/tus/abc")).toBe(false);
    expect(isUploadRequest("POST", "/api/uploadsx")).toBe(false);
    expect(isUploadRequest("POST", "/api/auth/login?x=/api/uploads")).toBe(false);
  });
});
