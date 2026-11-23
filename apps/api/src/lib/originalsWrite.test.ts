// The originals writer: moves keep the source until a verified copy exists and never replace a file.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const otherDrive = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const exdev = () => Promise.reject(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));
  return {
    ...real,
    // Only the first rename or link crosses "drives": the copy's own placement is on one drive.
    rename: (from: string, to: string) =>
      otherDrive.on && !from.endsWith(".lifer-partial") ? exdev() : real.rename(from, to),
    link: (from: string, to: string) =>
      otherDrive.on && !from.endsWith(".lifer-partial") ? exdev() : real.link(from, to),
  };
});

const { linkOrCopyOriginal, moveOriginal, removeOriginal } = await import("./originalsWrite.js");

let dir: string;
let src: string;
let dest: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lifer-originals-write-"));
  src = path.join(dir, "IMG_0001.jpg");
  dest = path.join(dir, "IMG_0001-moved.jpg");
  writeFileSync(src, "photo");
  otherDrive.on = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("moveOriginal", () => {
  it("copies across drives and deletes the source only after the copy", async () => {
    otherDrive.on = true;
    let sourceDuringCommit = false;
    await moveOriginal(src, dest, async () => {
      sourceDuringCommit = existsSync(src);
    });
    expect(sourceDuringCommit).toBe(true);
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(dest, "utf8")).toBe("photo");
  });

  it("never replaces a file at the destination, on any drive", async () => {
    for (const on of [false, true]) {
      otherDrive.on = on;
      writeFileSync(dest, "another photo");
      await expect(moveOriginal(src, dest)).rejects.toMatchObject({ code: "EEXIST" });
      expect(readFileSync(dest, "utf8")).toBe("another photo");
      expect(readFileSync(src, "utf8")).toBe("photo");
    }
  });
});

describe("linkOrCopyOriginal", () => {
  it("leaves the source in place whether it links or copies", async () => {
    for (const on of [false, true]) {
      otherDrive.on = on;
      rmSync(dest, { force: true });
      await linkOrCopyOriginal(src, dest);
      expect(readFileSync(dest, "utf8")).toBe("photo");
      expect(readFileSync(src, "utf8")).toBe("photo");
    }
  });
});

it("refuses a relative path", async () => {
  await expect(removeOriginal("IMG_0001.jpg")).rejects.toThrow(/relative/);
});
