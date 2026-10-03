import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { cookieSecureFor, hashToken } from "./session.js";

describe("hashToken", () => {
  // Must match migration 109's encode(digest(id, 'sha256'), 'hex') so existing sessions survive.
  it("is lowercase hex sha256", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("cookieSecureFor", () => {
  async function setCookieHeader(trustProxy: boolean | number, headers: Record<string, string> = {}): Promise<string> {
    // Same cast as index.ts: Fastify accepts a hop count but its types leave it out.
    const app = Fastify({ trustProxy: trustProxy as boolean | string[] });
    await app.register(cookie);
    app.get("/", async (request, reply) => {
      reply.setCookie("c", "v", { secure: cookieSecureFor(request), path: "/" });
      return { ok: true };
    });
    const res = await app.inject({ method: "GET", url: "/", headers });
    await app.close();
    return String(res.headers["set-cookie"]);
  }

  it("is not Secure over plain http", async () => {
    expect(await setCookieHeader(1)).not.toMatch(/Secure/);
    expect(await setCookieHeader(1, { "x-forwarded-proto": "http" })).not.toMatch(/Secure/);
  });

  it("is Secure behind an https proxy with the default hop-count trust", async () => {
    expect(await setCookieHeader(1, { "x-forwarded-proto": "https" })).toMatch(/Secure/);
  });

  it("is Secure behind an https proxy with full trust", async () => {
    expect(await setCookieHeader(true, { "x-forwarded-proto": "https" })).toMatch(/Secure/);
  });

  it("uses the hop the browser connected to when proxies chain", async () => {
    expect(await setCookieHeader(1, { "x-forwarded-proto": "https, http" })).toMatch(/Secure/);
    expect(await setCookieHeader(1, { "x-forwarded-proto": "http, https" })).not.toMatch(/Secure/);
  });
});
