import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  catalogManifestFiles,
  verifyCatalogSeed,
  staleCatalogAssets,
  versionCatalogManifest,
  versionedAssetName,
} from "./catalogPublish.js";

describe("catalogManifestFiles", () => {
  it("lists the seed and every vector asset the manifest names, nothing else", () => {
    expect(
      catalogManifestFiles({
        version: 1,
        publishedAt: "2026-01-01T00:00:00.000Z",
        seed: { url: "lifer-catalog-seed.sql.gz", sha256: "x", bytes: 1 },
        galleryEmbeddings: { url: "lifer-gallery-embeddings-clip-vit-l14-v2.bin.gz" },
        speciesTextEmbeddings: null,
      }),
    ).toEqual(["lifer-catalog-seed.sql.gz", "lifer-gallery-embeddings-clip-vit-l14-v2.bin.gz"]);
  });
});

describe("versionCatalogManifest", () => {
  it("puts the manifest version in every asset name and remembers each local file", () => {
    const { manifest, files } = versionCatalogManifest({
      version: 42,
      seed: { url: "lifer-catalog-seed.sql.gz", sha256: "x" },
      galleryEmbeddings: { url: "lifer-gallery-embeddings-clip-vit-l14-v2.bin.gz", rowCount: 3 },
      speciesTextEmbeddings: null,
    });
    expect(manifest.seed).toEqual({ url: "lifer-catalog-seed-42.sql.gz", sha256: "x" });
    expect(manifest.galleryEmbeddings).toEqual({
      url: "lifer-gallery-embeddings-clip-vit-l14-v2-42.bin.gz",
      rowCount: 3,
    });
    expect(manifest.speciesTextEmbeddings).toBeNull();
    expect([...files]).toEqual([
      ["lifer-catalog-seed-42.sql.gz", "lifer-catalog-seed.sql.gz"],
      ["lifer-gallery-embeddings-clip-vit-l14-v2-42.bin.gz", "lifer-gallery-embeddings-clip-vit-l14-v2.bin.gz"],
    ]);
    expect(versionedAssetName("notes.json", 7)).toBe("notes-7.json");
  });
});

describe("staleCatalogAssets", () => {
  it("keeps the new and replaced manifests' files, the manifest and the fixed-name seed", () => {
    const previous = { version: 1, seed: { url: "lifer-catalog-seed-1.sql.gz" } };
    const current = { version: 2, seed: { url: "lifer-catalog-seed-2.sql.gz" } };
    const assets = [
      "catalog-manifest.json",
      "lifer-catalog-seed.sql.gz",
      "lifer-catalog-seed-0.sql.gz",
      "lifer-catalog-seed-1.sql.gz",
      "lifer-catalog-seed-2.sql.gz",
      "lifer-gallery-embeddings-clip-vit-l14-v2.bin.gz",
      "README.txt",
    ];
    expect(staleCatalogAssets(assets, current, previous)).toEqual([
      "lifer-catalog-seed-0.sql.gz",
      "lifer-gallery-embeddings-clip-vit-l14-v2.bin.gz",
    ]);
  });
});

describe("verifyCatalogSeed", () => {
  const build = (seed: string, manifest: (sha: string, bytes: number) => object) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-seed-verify-"));
    writeFileSync(path.join(dir, "seed.sql.gz"), seed);
    const sha = createHash("sha256").update(seed).digest("hex");
    writeFileSync(path.join(dir, "catalog-manifest.json"), JSON.stringify(manifest(sha, Buffer.byteLength(seed))));
    return dir;
  };

  it("accepts files matching the manifest", async () => {
    const dir = build("seed", (sha256, bytes) => ({
      version: 1,
      seed: { url: "seed.sql.gz", sha256, bytes },
      galleryEmbeddings: null,
    }));
    try {
      await expect(verifyCatalogSeed(dir)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a missing file, a size or hash mismatch, or no seed", async () => {
    const cases: Array<[(sha: string, bytes: number) => object, RegExp]> = [
      [
        (sha256, bytes) => ({
          version: 1,
          seed: { url: "seed.sql.gz", sha256, bytes },
          x: { url: "gone.bin.gz", sha256, bytes },
        }),
        /gone.bin.gz is missing/,
      ],
      [
        (sha256, bytes) => ({ version: 1, seed: { url: "seed.sql.gz", sha256, bytes: bytes + 1 } }),
        /the manifest says/,
      ],
      [(_sha, bytes) => ({ version: 1, seed: { url: "seed.sql.gz", sha256: "0", bytes } }), /doesn't match its sha256/],
      [() => ({ version: 1 }), /lists no seed/],
    ];
    for (const [manifest, error] of cases) {
      const dir = build("seed", manifest);
      try {
        await expect(verifyCatalogSeed(dir)).rejects.toThrow(error);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
