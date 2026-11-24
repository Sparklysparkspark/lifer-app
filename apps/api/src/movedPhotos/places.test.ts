// The rules that keep the places list one entry per folder tree, and the folder Lifer suggests
// adding when photos can't be found.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commonFolder, parentFolder } from "@lifer/shared";
import { afterAll, describe, expect, it } from "vitest";
import { diskPath, placeOverlap, type Places } from "./relink.js";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "lifer-places-")));
for (const d of ["lib", "trips/Belize", "watched", "Photos/2025", "Photos/2026", "Other"])
  mkdirSync(path.join(root, d), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const at = (p: string) => path.join(root, p);

const places = (chosen: string[]): Places => ({
  library: at("lib"),
  trips: [at("trips/Belize")],
  watched: [at("watched")],
  chosen,
});

describe("placeOverlap", () => {
  it("says which place already covers a folder, fixed ones included", () => {
    expect(placeOverlap(places([]), at("lib/Birds"))).toEqual({ coveredBy: at("lib"), contains: [] });
    expect(placeOverlap(places([]), at("trips/Belize"))).toEqual({ coveredBy: at("trips/Belize"), contains: [] });
    expect(placeOverlap(places([at("Photos")]), at("Photos/2025")).coveredBy).toBe(at("Photos"));
    // A sibling whose name starts the same isn't inside.
    expect(placeOverlap(places([at("Photos/2025")]), at("Photos/20")).coveredBy).toBeNull();
  });

  it("lists the user's own places a parent would replace, never the fixed ones", () => {
    const chosen = [at("Photos/2025"), at("Photos/2026"), at("Other")];
    expect(placeOverlap(places(chosen), at("Photos"))).toEqual({
      coveredBy: null,
      contains: [at("Photos/2025"), at("Photos/2026")],
    });
    expect(placeOverlap(places(chosen), root).contains).toEqual(chosen);
  });

  it.skipIf(process.platform === "linux")("ignores letter case where volumes do", () => {
    expect(placeOverlap(places([at("Photos")]), at("photos/2025").toUpperCase()).coveredBy).toBe(at("Photos"));
  });
});

describe("diskPath", () => {
  it("drops a trailing separator and returns null for a folder that isn't there", () => {
    expect(diskPath(at("Photos") + path.sep)).toBe(at("Photos"));
    expect(diskPath(at("Not connected"))).toBeNull();
  });
});

describe("commonFolder", () => {
  it("finds the folder the missing photos shared", () => {
    expect(
      commonFolder([
        "/Users/ana/Pictures/Family Trips/Belize 2026/Day 1/a.jpg",
        "/Users/ana/Pictures/Family Trips/Belize 2026/Day 2/b.jpg",
      ]),
    ).toBe("/Users/ana/Pictures/Family Trips/Belize 2026");
    expect(commonFolder(["/Users/ana/Pictures/a.jpg"])).toBe("/Users/ana/Pictures");
    expect(commonFolder(["C:\\Photos\\Belize\\a.jpg", "C:\\Photos\\Peru\\b.jpg"])).toBe("C:\\Photos");
  });

  it("suggests nothing too broad or empty", () => {
    expect(commonFolder([])).toBeNull();
    expect(commonFolder(["/Volumes/a.jpg", "/Users/b.jpg"])).toBeNull();
    expect(commonFolder(["/Volumes/One/a.jpg", "/Volumes/Two/b.jpg"])).toBeNull();
  });

  it("parentFolder steps up one level", () => {
    expect(parentFolder("/Users/ana/Pictures/Family Trips/Belize 2026")).toBe("/Users/ana/Pictures/Family Trips");
    expect(parentFolder("/Photos/")).toBe("/");
    expect(parentFolder("C:\\Photos\\Belize")).toBe("C:\\Photos");
  });
});
