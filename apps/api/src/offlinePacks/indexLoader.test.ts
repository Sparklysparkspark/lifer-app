// The saved pack index is about 22 MB of JSON, nearly all species names. Reading it must not hold
// up the API: it's parsed in a worker, and the main thread only takes back the result.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { loadIndexFile, namesOf } from "./indexLoader.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-index-loader-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Same shape as the published index: thousands of packs, each with a long list of names.
function writeSyntheticIndex(file: string): number {
  const pool = Array.from({ length: 40_000 }, (_, i) => `Genus${i % 3000} species${i}`);
  const packs = Array.from({ length: 5_600 }, (_, i) => ({
    id: `country-${i}`,
    type: "region",
    region: `Country ${i % 250}`,
    taxon: "aves",
    sizeBytes: 100_000 + i,
    speciesCount: 160,
    contentVersion: `v${i}`,
    scientificNames: Array.from({ length: 160 }, (_, j) => pool[(i * 37 + j * 101) % pool.length]),
    url: "https://packs.invalid/shard.bin",
    range: [i * 1000, 1000],
  }));
  const json = JSON.stringify({ generatedAt: "2026-11-12T00:00:00Z", packs });
  writeFileSync(file, json);
  return json.length;
}

describe("loadIndexFile", () => {
  it("reads a 22 MB index without stalling the event loop, with names intact and a lite copy", async () => {
    const file = path.join(dir, "full.json");
    expect(writeSyntheticIndex(file)).toBeGreaterThan(20_000_000);
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const loaded = await loadIndexFile(file, { writeLiteTo: path.join(dir, "lite.json") });
    delay.disable();
    expect(delay.max / 1e6).toBeLessThan(100);

    expect(loaded.index.packs).toHaveLength(5_600);
    expect(loaded.index.packs[7].scientificNames).toEqual([]);
    const original = JSON.parse(readFileSync(file, "utf8")).packs[7].scientificNames as string[];
    expect(namesOf(loaded.names!, 7)).toEqual(original);

    const lite = JSON.parse(readFileSync(path.join(dir, "lite.json"), "utf8"));
    expect(lite.packs[7]).not.toHaveProperty("scientificNames");
    expect(readFileSync(path.join(dir, "lite.json")).length).toBeLessThan(5_000_000);
  }, 60_000);

  it("refuses a file that isn't a pack index", async () => {
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ generatedAt: "x", packs: [{ id: 3 }] }));
    await expect(loadIndexFile(bad)).rejects.toThrow(/malformed/);
  });
});
