import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAlbumIndex } from "./albumIndex.js";

describe("readAlbumIndex", () => {
  let folder: string;
  let file: string;

  beforeEach(() => {
    folder = mkdtempSync(path.join(tmpdir(), "lifer-album-index-"));
    mkdirSync(path.join(folder, ".lifer"));
    file = path.join(folder, ".lifer", "albums.json");
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it("reads an index, and treats a missing one as empty", () => {
    expect(readAlbumIndex(folder)).toEqual({});
    writeFileSync(file, JSON.stringify({ "a.jpg": ["Birds"] }));
    expect(readAlbumIndex(folder)).toEqual({ "a.jpg": ["Birds"] });
  });

  it("moves a corrupt index aside instead of letting a write replace it", () => {
    for (const text of ["{ not json", "[1, 2]"]) {
      writeFileSync(file, text);
      expect(readAlbumIndex(folder)).toEqual({});
      expect(existsSync(file)).toBe(false);
      expect(readFileSync(`${file}.corrupt`, "utf8")).toBe(text);
    }
  });
});
