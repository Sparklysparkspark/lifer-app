import { describe, expect, it, vi } from "vitest";
import { parseLibraryRoots } from "./config.js";

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
