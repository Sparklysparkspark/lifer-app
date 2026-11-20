import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPackIndex, writePackIndexFiles, type PackIndex } from "./packIndex.js";

describe("writePackIndexFiles", () => {
  it("writes the full index and a lite one without species names, which installs fetch first", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-index-files-"));
    try {
      const index: PackIndex = {
        generatedAt: "2026-11-10T00:00:00Z",
        packs: [
          {
            id: "canada-aves",
            type: "region",
            region: "Canada",
            taxon: "aves",
            sizeBytes: 1234,
            speciesCount: 2,
            contentVersion: "v1",
            scientificNames: ["Turdus migratorius", "Poecile atricapillus"],
            url: "https://example.invalid/shard.bin",
            range: [0, 1234],
            sha256: "abc",
            format: 3,
          },
        ],
      };
      writePackIndexFiles(dir, index);
      const full = JSON.parse(readFileSync(path.join(dir, "pack-index.json"), "utf8"));
      expect(isPackIndex(full)).toBe(true);
      expect(full.packs[0].scientificNames).toHaveLength(2);
      const lite = JSON.parse(readFileSync(path.join(dir, "pack-index-lite.json"), "utf8"));
      expect(lite.packs[0]).not.toHaveProperty("scientificNames");
      // Everything an install needs to list and download a pack stays.
      const { scientificNames: _names, ...rest } = index.packs[0];
      expect(lite.packs[0]).toEqual(rest);
      expect(lite.generatedAt).toBe(index.generatedAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
