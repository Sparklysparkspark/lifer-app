// The index is built from the packs' own manifests, merged with what's published. Archives are
// real tar.gz files in a temp folder; nothing is fetched (main() isn't run on import).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IndexPack } from "../pipeline/packIndex.js";
import { buildPackIndex } from "./build-pack-index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-index-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function archive(fileName: string, manifest: object) {
  const stage = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-stage-"));
  try {
    writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest));
    tar.create({ gzip: true, file: path.join(dir, fileName), cwd: stage, sync: true }, ["manifest.json"]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const published = (id: string, format?: number): IndexPack => ({
  id,
  type: "region",
  sizeBytes: 1,
  speciesCount: 1,
  contentVersion: "old",
  scientificNames: [],
  url: "lifer-packs-1.bin",
  format,
});

describe("buildPackIndex", () => {
  it("indexes each archive from its manifest and keeps published packs this batch didn't rebuild", () => {
    archive("kenya-aves.pack.tar.gz", {
      type: "region",
      region: "Kenya",
      taxon: "aves",
      speciesCount: 2,
      contentVersion: "v2",
      species: [{ scientificName: "Pica pica" }, { scientificName: "Corvus corax" }],
      children: [{ species: [{ scientificName: "Pica pica" }, { scientificName: "Turdus merula" }] }],
      seaZoneDependencies: [{ name: "Red Sea", packFile: "seazone-red_sea-aves.pack.tar.gz" }],
    });
    const index = buildPackIndex(dir, {
      generatedAt: "2026-01-01T00:00:00.000Z",
      packs: [published("kenya-aves", 3), published("peru-aves", 3), published("chile-aves")],
    });
    expect(index.packs.map((p) => p.id)).toEqual(["peru-aves", "kenya-aves"]);
    const kenya = index.packs[1];
    expect(kenya).toMatchObject({ format: 3, variant: "full", contentVersion: "v2", speciesCount: 2, url: "" });
    expect(kenya.scientificNames).toEqual(["Pica pica", "Corvus corax", "Turdus merula"]);
    expect(kenya.seaZoneDependencies).toEqual(["seazone-red_sea-aves"]);
    expect(index.photoStore.indexUrl).toMatch(/lifer-photo-store\.json\.gz$/);
  });

  it("refuses a folder with no packs", () => {
    expect(() => buildPackIndex(dir, { generatedAt: "", packs: [] })).toThrow(/No .pack.tar.gz files/);
  });
});
