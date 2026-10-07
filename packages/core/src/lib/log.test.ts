import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  delete process.env.LOG_LEVEL;
  vi.resetModules();
});

async function loadLog() {
  vi.resetModules();
  return (await import("./log.js")).log;
}

describe("log level", () => {
  it("defaults to info", async () => {
    expect((await loadLog()).level).toBe("info");
  });

  it("follows LOG_LEVEL", async () => {
    process.env.LOG_LEVEL = "debug";
    expect((await loadLog()).level).toBe("debug");
  });

  it("falls back to info on a typo instead of throwing", async () => {
    process.env.LOG_LEVEL = "verbose";
    expect((await loadLog()).level).toBe("info");
  });
});
