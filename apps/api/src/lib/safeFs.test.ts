import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDir, writeNewFile, copyToNewFile, moveToFolder, uniqueDestination } from "./safeFs.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "lifer-safefs-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ensureDir", () => {
  it("creates every missing level", async () => {
    const dir = path.join(root, "Wildlife 2026", "Birds", "Pileated Woodpecker", "Adjusted");
    await ensureDir(dir);
    expect(existsSync(dir)).toBe(true);
    await ensureDir(dir); // already there is fine
  });

  it("fails with the folder's name instead of retrying when a file is in the way", async () => {
    writeFileSync(path.join(root, "Birds"), "not a folder");
    await expect(ensureDir(path.join(root, "Birds", "Osprey", "RAW"))).rejects.toThrow(/Couldn't create folder .*Birds/);
  });
});

describe("writeNewFile", () => {
  it("never overwrites: same name gets -2, -3", async () => {
    const dir = path.join(root, "Adjusted");
    const a = await writeNewFile(dir, "IMG_0001.jpg", Buffer.from("a"));
    const b = await writeNewFile(dir, "IMG_0001.jpg", Buffer.from("b"));
    const c = await writeNewFile(dir, "IMG_0001.jpg", Buffer.from("c"));
    expect([a, b, c].map((p) => path.basename(p))).toEqual(["IMG_0001.jpg", "IMG_0001-2.jpg", "IMG_0001-3.jpg"]);
    expect(readFileSync(a, "utf8")).toBe("a");
    expect(readFileSync(c, "utf8")).toBe("c");
  });

  it("gives two uploads of the same name at the same moment their own files", async () => {
    const dir = path.join(root, "Adjusted");
    const paths = await Promise.all(["x", "y", "z", "w"].map((v) => writeNewFile(dir, "IMG_0001.jpg", Buffer.from(v))));
    expect(new Set(paths).size).toBe(4);
    expect(paths.map((p) => readFileSync(p, "utf8")).sort()).toEqual(["w", "x", "y", "z"]);
  });

  it("handles names without an extension", async () => {
    await writeNewFile(root, "README", Buffer.from("1"));
    expect(path.basename(await writeNewFile(root, "README", Buffer.from("2")))).toBe("README-2");
  });
});

describe("copyToNewFile, moveToFolder, uniqueDestination", () => {
  it("copies without overwriting", async () => {
    const src = path.join(root, "clip.mp4");
    writeFileSync(src, "video");
    const dir = path.join(root, "Video");
    await copyToNewFile(dir, "clip.mp4", src);
    const second = await copyToNewFile(dir, "clip.mp4", src);
    expect(path.basename(second)).toBe("clip-2.mp4");
    expect(existsSync(src)).toBe(true);
  });

  it("moves into a new folder under a free name", async () => {
    const src = path.join(root, "holding", "IMG_0002.CR3");
    await ensureDir(path.dirname(src));
    writeFileSync(src, "raw");
    const dir = path.join(root, "Birds", "Osprey", "RAW");
    await ensureDir(dir);
    writeFileSync(path.join(dir, "IMG_0002.CR3"), "someone else");
    const dest = await moveToFolder(src, dir);
    expect(path.basename(dest)).toBe("IMG_0002-2.CR3");
    expect(existsSync(src)).toBe(false);
    expect(await uniqueDestination(dir, "IMG_0002.CR3")).toBe(path.join(dir, "IMG_0002-3.CR3"));
  });
});
