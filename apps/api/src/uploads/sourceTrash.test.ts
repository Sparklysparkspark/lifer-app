import { describe, expect, it } from "vitest";
import { trashBlock } from "./sourceTrash.js";

const ok = { inSourceFolder: true, inLibrary: false, sourceHash: "abc", libraryCopyOk: true };

describe("trashBlock: when an original may go to the Trash", () => {
  it("only a readable file in a chosen folder, outside the library, with a proven library copy", () => {
    expect(trashBlock(ok)).toBeNull();
  });

  it.each([
    [{ inSourceFolder: false }, "not_in_source_folder"],
    [{ inLibrary: true }, "in_library"],
    [{ sourceHash: null }, "unreadable"],
    [{ libraryCopyOk: false }, "no_library_copy"],
    // The library's own folder wins over everything after where the file is.
    [{ inLibrary: true, libraryCopyOk: false }, "in_library"],
  ])("%o stays: %s", (change, reason) => {
    expect(trashBlock({ ...ok, ...change })).toBe(reason);
  });
});
