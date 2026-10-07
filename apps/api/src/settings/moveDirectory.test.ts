import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lifer/core/db.js", () => ({ pool: {} }));

const { moveDirectoryContents } = await import("./storageMove.js");
const { removeEmptyDirsUpward } = await import("../lib/fsCleanup.js");

describe("moveDirectoryContents", () => {
  it("moves a whole folder tree to a new location", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lifer-move-"));
    const from = path.join(root, "old");
    mkdirSync(path.join(from, "a", "b"), { recursive: true });
    writeFileSync(path.join(from, "a", "b", "photo.jpg"), "bytes");
    const to = path.join(root, "nested", "new");
    await moveDirectoryContents(from, to);
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(path.join(to, "a", "b", "photo.jpg"), "utf-8")).toBe("bytes");
  });
});

describe("removeEmptyDirsUpward", () => {
  it("removes empty (or junk-only) folders up to but not including the stop folder", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lifer-rm-"));
    const deep = path.join(root, "x", "y");
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, ".DS_Store"), "");
    writeFileSync(path.join(root, "keep.txt"), "");
    await removeEmptyDirsUpward(deep, root);
    expect(existsSync(path.join(root, "x"))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("stops at a folder that still has real content", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lifer-rm-"));
    const deep = path.join(root, "x", "y");
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(root, "x", "other.jpg"), "");
    await removeEmptyDirsUpward(deep, root);
    expect(existsSync(deep)).toBe(false);
    expect(existsSync(path.join(root, "x", "other.jpg"))).toBe(true);
  });
});

describe("removeEmptyDirsUpward with symlinks", () => {
  it("tidies up to a stop folder spelled through a symlink when the start is a realpath", async () => {
    const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lifer-rm-link-")));
    try {
      const root = path.join(tmp, "originals");
      const deep = path.join(root, "x", "y");
      mkdirSync(deep, { recursive: true });
      const linkedRoot = path.join(tmp, "linked-originals");
      symlinkSync(root, linkedRoot);
      await removeEmptyDirsUpward(deep, linkedRoot);
      expect(existsSync(path.join(root, "x"))).toBe(false);
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("removes nothing through a symlink that leads out of the stop folder", async () => {
    const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lifer-rm-escape-")));
    try {
      const root = path.join(tmp, "originals");
      const outsideEmpty = path.join(tmp, "outside", "empty");
      mkdirSync(root);
      mkdirSync(outsideEmpty, { recursive: true });
      symlinkSync(path.join(tmp, "outside"), path.join(root, "escape"));
      await removeEmptyDirsUpward(path.join(root, "escape", "empty"), root);
      expect(existsSync(outsideEmpty)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
