import { describe, expect, it } from "vitest";
import { catalogManifestFiles, parseArgs, resumeArgv } from "./refresh.js";

describe("refresh parseArgs", () => {
  it("runs requested stages in pipeline order", () => {
    expect(parseArgs(["--stages=publish,gate,packs", "--publish"]).stages).toEqual(["packs", "gate", "publish"]);
  });

  it("leaves publish out unless asked", () => {
    expect(parseArgs([]).stages).not.toContain("publish");
    expect(parseArgs(["--publish"]).stages.at(-1)).toBe("publish");
  });

  it("refuses an unknown stage", () => {
    expect(() => parseArgs(["--stages=packs,pubish"])).toThrow(/Unknown stage "pubish"/);
  });
});

describe("resumeArgv", () => {
  it("lets a value given now win over the resumed run's", () => {
    const argv = resumeArgv(
      ["--resume", "--countries=Canada", "--stages=gate"],
      ["--countries=Mexico", "--stages=packs", "--publish"],
    );
    const opts = parseArgs(argv);
    expect(opts.countries).toEqual(["Canada"]);
    expect(opts.stages).toEqual(["gate"]);
    expect(opts.publish).toBe(true);
  });

  it("keeps the resumed run's flags and adds new ones", () => {
    expect(resumeArgv(["--resume", "--allow-tier-skip"], ["--resume", "--publish"])).toEqual([
      "--resume",
      "--allow-tier-skip",
      "--publish",
    ]);
  });
});

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
