import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RAW_DIR, fetchCached } from "./rawCache.js";

const source = `rawcache-test-${process.pid}`;
const dir = path.join(RAW_DIR, source);

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("fetchCached", () => {
  it("replaces a half-written download instead of treating it as cached", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "data.json.part"), '{"trunc');
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"ok":true}')));
    const dest = await fetchCached(source, "data.json", "https://example.test/data.json");
    expect(JSON.parse(readFileSync(dest, "utf-8"))).toEqual({ ok: true });
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("caches nothing when the download fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    await expect(fetchCached(source, "data.json", "https://example.test/data.json")).rejects.toThrow(/500/);
    expect(existsSync(path.join(dir, "data.json"))).toBe(false);
  });
});
