// The Docker image's bundled catalog seed is checked against its manifest's sha256 before loading.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLED_REGIONS_FILE, BUNDLED_SEED_FILE, verifiedBundledSeed } from "./catalogSeedUpdate.js";

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

describe("verifiedBundledSeed", () => {
  let dir: string;
  const write = (name: string, data: string) => writeFileSync(path.join(dir, name), data);
  const manifest = (m: object) => write("catalog-manifest.json", JSON.stringify(m));

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-bundled-seed-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is null when the image has no bundled seed", async () => {
    expect(await verifiedBundledSeed(dir)).toBeNull();
  });

  it("uses a seed that matches its manifest, and the regions file that matches its own checksum", async () => {
    write(BUNDLED_SEED_FILE, "seed bytes");
    write(BUNDLED_REGIONS_FILE, "regions bytes");
    manifest({ version: 7, seed: { sha256: sha256("seed bytes") }, regionsOnly: { sha256: sha256("regions bytes") } });
    expect(await verifiedBundledSeed(dir)).toEqual({
      path: path.join(dir, BUNDLED_SEED_FILE),
      version: 7,
      regionsPath: path.join(dir, BUNDLED_REGIONS_FILE),
    });
  });

  it("refuses a seed that doesn't match its manifest", async () => {
    write(BUNDLED_SEED_FILE, "tampered seed");
    manifest({ version: 7, seed: { sha256: sha256("seed bytes") } });
    await expect(verifiedBundledSeed(dir)).rejects.toThrow(/doesn't match the checksum/);
  });

  it("refuses a regions file that doesn't match, and skips one with no checksum", async () => {
    write(BUNDLED_SEED_FILE, "seed bytes");
    write(BUNDLED_REGIONS_FILE, "tampered regions");
    manifest({ version: 7, seed: { sha256: sha256("seed bytes") }, regionsOnly: { sha256: sha256("regions bytes") } });
    await expect(verifiedBundledSeed(dir)).rejects.toThrow(/regions file/);

    manifest({ version: 7, seed: { sha256: sha256("seed bytes") } });
    expect((await verifiedBundledSeed(dir))?.regionsPath).toBeNull();
  });

  it("uses a seed with no manifest, unversioned, as before checksums", async () => {
    write(BUNDLED_SEED_FILE, "seed bytes");
    expect(await verifiedBundledSeed(dir)).toEqual({
      path: path.join(dir, BUNDLED_SEED_FILE),
      version: null,
      regionsPath: null,
    });
  });
});
