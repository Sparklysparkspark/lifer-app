import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerRateLimit } from "./rateLimit.js";

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

  it("is off at 0", async () => {
    const app = await appWithLimit(0);
    for (let i = 0; i < 5; i++) expect((await app.inject("/ping")).statusCode).toBe(200);
    await app.close();
  });
});
