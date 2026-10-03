import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ pool: {} }));

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
