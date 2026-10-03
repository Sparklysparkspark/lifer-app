import { describe, expect, it } from "vitest";
import { hasForwardedHeaders, isBlockedCrossSiteWrite, redactShareTokens } from "./requestGuard.js";

const HOSTS = ["lifer.example.com", undefined];
const client = { "x-lifer-client": "1" };

describe("isBlockedCrossSiteWrite", () => {
  it.each(["GET", "HEAD", "OPTIONS", "get"])("never blocks %s", (method) => {
    expect(isBlockedCrossSiteWrite(method, { "sec-fetch-site": "cross-site" }, HOSTS)).toBe(false);
  });

  it("blocks a write without the client header", () => {
    expect(isBlockedCrossSiteWrite("POST", { "sec-fetch-site": "same-origin" }, HOSTS)).toBe(true);
  });

  it("lets API-key clients through without the client header", () => {
    expect(isBlockedCrossSiteWrite("POST", { "x-api-key": "abc" }, HOSTS)).toBe(false);
  });

  it.each(["same-origin", "none"])("allows Sec-Fetch-Site %s", (site) => {
    expect(isBlockedCrossSiteWrite("POST", { ...client, "sec-fetch-site": site }, HOSTS)).toBe(false);
  });

  it.each(["same-site", "cross-site"])("blocks Sec-Fetch-Site %s", (site) => {
    expect(isBlockedCrossSiteWrite("DELETE", { ...client, "sec-fetch-site": site }, HOSTS)).toBe(true);
  });

  it("allows a matching Origin when Sec-Fetch-Site is absent", () => {
    expect(isBlockedCrossSiteWrite("PUT", { ...client, origin: "https://Lifer.example.com" }, HOSTS)).toBe(false);
  });

  it("blocks a different Origin, including another port on the same host", () => {
    expect(isBlockedCrossSiteWrite("POST", { ...client, origin: "https://evil.example" }, HOSTS)).toBe(true);
    expect(isBlockedCrossSiteWrite("POST", { ...client, origin: "http://127.0.0.1:5000" }, ["127.0.0.1:4310"])).toBe(true);
    expect(isBlockedCrossSiteWrite("POST", { ...client, origin: "null" }, HOSTS)).toBe(true);
  });

  it("allows a write with neither Origin nor Sec-Fetch-Site (non-browser client)", () => {
    expect(isBlockedCrossSiteWrite("POST", client, HOSTS)).toBe(false);
  });

  it("requires the header value to be exactly 1", () => {
    expect(isBlockedCrossSiteWrite("POST", { "x-lifer-client": "yes" }, HOSTS)).toBe(true);
  });
});

describe("hasForwardedHeaders", () => {
  it.each(["x-forwarded-for", "x-forwarded-host", "forwarded"])("detects %s", (name) => {
    expect(hasForwardedHeaders({ [name]: "1.2.3.4" })).toBe(true);
  });
  it("ignores ordinary requests", () => {
    expect(hasForwardedHeaders({ host: "127.0.0.1:4310" })).toBe(false);
  });
});

describe("redactShareTokens", () => {
  it("hides tokens in share paths", () => {
    expect(redactShareTokens("/api/share/abc123/photos/p1/thumb?download=1")).toBe("/api/share/[redacted]/photos/p1/thumb?download=1");
    expect(redactShareTokens("/share/abc123")).toBe("/share/[redacted]");
    expect(redactShareTokens("/api/shares/abc123")).toBe("/api/shares/[redacted]");
  });
  it("leaves other paths alone", () => {
    expect(redactShareTokens("/api/albums/1/shares")).toBe("/api/albums/1/shares");
  });
});
