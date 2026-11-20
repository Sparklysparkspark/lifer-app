import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMapExtracts, MAP_INDEX_NAME, readMapIndex, type CutFn, type MapCountry } from "./maps.js";

const square = (x: number) => ({
  type: "Polygon",
  coordinates: [
    [
      [x, 0],
      [x + 1, 0],
      [x + 1, 1],
      [x, 1],
      [x, 0],
    ],
  ],
});
const BEL: MapCountry = { code: "BEL", name: "Belgium", boundary: square(4) };
const LUX: MapCountry = { code: "LUX", name: "Luxembourg", boundary: square(6) };

// Stands in for `pmtiles extract`: writes bytes derived from the region it was given.
function fakeCut(calls: string[]): CutFn {
  return (source, regionFile, outFile) => {
    const region = path.basename(regionFile).split(".")[0];
    calls.push(region);
    if (region === "BAD") throw new Error("extract failed");
    writeFileSync(outFile, `${source}:${readFileSync(regionFile, "utf8")}`);
  };
}

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () => (dir = mkdtempSync(path.join(os.tmpdir(), "lifer-maps-")));

describe("buildMapExtracts", () => {
  it("cuts each country once, then only what changed", async () => {
    fresh();
    const calls: string[] = [];
    const first = await buildMapExtracts({
      countries: [BEL, LUX],
      source: "planet-a",
      outDir: dir,
      cut: fakeCut(calls),
      log: () => {},
    });
    expect(first.changed).toEqual(["BEL", "LUX"]);
    expect(first.index.extracts.map((e) => e.code)).toEqual(["BEL", "LUX"]);
    for (const e of first.index.extracts) {
      expect(e.file).toMatch(/^detail-[a-z]+-[0-9a-f]{12}\.pmtiles$/);
      expect(e.sha256).toHaveLength(64);
      expect(e.sizeBytes).toBeGreaterThan(0);
      expect(existsSync(path.join(dir, e.file))).toBe(true);
    }

    // Nothing changed: nothing is cut again.
    const again = await buildMapExtracts({
      countries: [BEL, LUX],
      source: "planet-a",
      outDir: dir,
      cut: fakeCut(calls),
      log: () => {},
    });
    expect(again.changed).toEqual([]);
    expect(calls).toEqual(["BEL", "LUX"]);

    // A new boundary recuts that country only, and its old file goes.
    const oldFile = first.index.extracts[0].file;
    const moved = await buildMapExtracts({
      countries: [{ ...BEL, boundary: square(5) }, LUX],
      source: "planet-a",
      outDir: dir,
      cut: fakeCut(calls),
      log: () => {},
    });
    expect(moved.changed).toEqual(["BEL"]);
    expect(moved.index.extracts[0].file).not.toBe(oldFile);
    expect(existsSync(path.join(dir, oldFile))).toBe(false);

    // A new planet build recuts everything.
    const rebuilt = await buildMapExtracts({
      countries: [LUX],
      source: "planet-b",
      outDir: dir,
      cut: fakeCut(calls),
      partial: true,
      log: () => {},
    });
    expect(rebuilt.changed).toEqual(["LUX"]);
    // A --countries run keeps the others.
    expect(rebuilt.index.extracts.map((e) => e.code)).toEqual(["BEL", "LUX"]);
  });

  it("drops countries no longer listed on a full run", async () => {
    fresh();
    const calls: string[] = [];
    const first = await buildMapExtracts({
      countries: [BEL, LUX],
      source: "p",
      outDir: dir,
      cut: fakeCut(calls),
      log: () => {},
    });
    const lux = first.index.extracts.find((e) => e.code === "LUX")!;
    const after = await buildMapExtracts({
      countries: [BEL],
      source: "p",
      outDir: dir,
      cut: fakeCut(calls),
      log: () => {},
    });
    expect(after.index.extracts.map((e) => e.code)).toEqual(["BEL"]);
    expect(existsSync(path.join(dir, lux.file))).toBe(false);
  });

  it("keeps finished countries when one fails, and leaves no partial file", async () => {
    fresh();
    const result = await buildMapExtracts({
      countries: [
        BEL,
        { code: "BAD", name: "Broken", boundary: square(9) },
        { code: "../x", name: "Evil", boundary: square(1) },
      ],
      source: "p",
      outDir: dir,
      cut: fakeCut([]),
      log: () => {},
    });
    expect(result.failures.map((f) => f.code)).toEqual(["BAD", "../x"]);
    expect(readMapIndex(dir)!.extracts.map((e) => e.code)).toEqual(["BEL"]);
    expect(readdirSync(dir).sort()).toEqual([MAP_INDEX_NAME, result.index.extracts[0].file].sort());
  });
});
