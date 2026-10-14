// moveOriginalFile: a reorganized file ends up either moved with its new path saved, or back where
// it was with nothing saved; never moved with the old path still stored.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameFails = { next: false };
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // Simulates a move across drives, where a rename can't work and the file is copied instead.
    rename: vi.fn(async (from: string, to: string) => {
      if (renameFails.next) {
        renameFails.next = false;
        throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
      }
      return actual.rename(from, to);
    }),
  };
});
vi.mock("@lifer/core/db.js", () => ({ pool: { query: vi.fn() } }));

let dir: string;
let current: string;
let dest: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lifer-reorganize-"));
  current = path.join(dir, "IMG_0001.jpg");
  dest = path.join(dir, "IMG_0001-moved.jpg");
  writeFileSync(current, "photo");
  renameFails.next = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("moveOriginalFile", () => {
  it("moves the file and saves its new path", async () => {
    const { moveOriginalFile } = await import("./reorganizeOriginals.js");
    const saveRef = vi.fn(async () => {});
    await moveOriginalFile(current, dest, saveRef);
    expect(saveRef).toHaveBeenCalledOnce();
    expect(existsSync(current)).toBe(false);
    expect(readFileSync(dest, "utf8")).toBe("photo");
  });

  it("renames the file back when saving its new path fails", async () => {
    const { moveOriginalFile } = await import("./reorganizeOriginals.js");
    await expect(
      moveOriginalFile(current, dest, async () => {
        throw new Error("database down");
      }),
    ).rejects.toThrow("database down");
    expect(readFileSync(current, "utf8")).toBe("photo");
    expect(existsSync(dest)).toBe(false);
  });

  it("copies across drives and removes the source only once the new path is saved", async () => {
    const { moveOriginalFile } = await import("./reorganizeOriginals.js");
    renameFails.next = true;
    let sourceDuringSave = false;
    await moveOriginalFile(current, dest, async () => {
      sourceDuringSave = existsSync(current);
    });
    expect(sourceDuringSave).toBe(true);
    expect(existsSync(current)).toBe(false);
    expect(readFileSync(dest, "utf8")).toBe("photo");
  });

  it("removes the copy and keeps the source when saving fails after a copy", async () => {
    const { moveOriginalFile } = await import("./reorganizeOriginals.js");
    renameFails.next = true;
    await expect(
      moveOriginalFile(current, dest, async () => {
        throw new Error("database down");
      }),
    ).rejects.toThrow("database down");
    expect(readFileSync(current, "utf8")).toBe("photo");
    expect(existsSync(dest)).toBe(false);
  });

  it("leaves nothing behind when the copy itself fails", async () => {
    const { moveOriginalFile } = await import("./reorganizeOriginals.js");
    renameFails.next = true;
    const saveRef = vi.fn(async () => {});
    await expect(moveOriginalFile(current, path.join(dir, "missing", "x.jpg"), saveRef)).rejects.toThrow();
    expect(saveRef).not.toHaveBeenCalled();
    expect(readFileSync(current, "utf8")).toBe("photo");
  });
});
