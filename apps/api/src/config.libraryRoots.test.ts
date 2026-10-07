import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseLibraryRoots } from "@lifer/core/config.js";

describe("parseLibraryRoots", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});

  it("returns nothing when unset or blank", () => {
    expect(parseLibraryRoots(undefined, "/data")).toEqual([]);
    expect(parseLibraryRoots("  ", "/data")).toEqual([]);
  });

  it("reads labeled and bare entries", () => {
    expect(parseLibraryRoots("NAS=/library/nas, /library/archive", "/data")).toEqual([
      { label: "NAS", path: "/library/nas" },
      { label: "archive", path: "/library/archive" },
    ]);
  });

  it("skips relative paths, the filesystem root, and anything inside DATA_DIR", () => {
    expect(parseLibraryRoots("rel/path,/,/data,/data/sub,Ok=/elsewhere", "/data")).toEqual([
      { label: "Ok", path: "/elsewhere" },
    ]);
  });

  it("allows a sibling that only shares a name prefix with DATA_DIR", () => {
    expect(parseLibraryRoots("/data2", "/data")).toEqual([{ label: "data2", path: "/data2" }]);
  });

  it("normalizes trailing slashes and drops duplicates", () => {
    expect(parseLibraryRoots("A=/library/nas/,B=/library/nas,,", "/data")).toEqual([{ label: "A", path: "/library/nas" }]);
  });
});

describe("parseLibraryRoots with a symlinked DATA_DIR", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});

  it("skips a root inside DATA_DIR whichever side is spelled through the symlink", () => {
    const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lifer-roots-")));
    try {
      const realData = path.join(tmp, "data");
      mkdirSync(path.join(realData, "sub"), { recursive: true });
      const linkedData = path.join(tmp, "linked-data");
      symlinkSync(realData, linkedData);
      expect(parseLibraryRoots(path.join(realData, "sub"), linkedData)).toEqual([]);
      expect(parseLibraryRoots(path.join(linkedData, "sub"), realData)).toEqual([]);
      expect(parseLibraryRoots(`${realData}2`, linkedData)).toEqual([{ label: "data2", path: `${realData}2` }]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
