import { describe, expect, it } from "vitest";
import path from "node:path";
import { sidecarsIn, trashBlock } from "./sourceTrash.js";

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

describe("sidecarsIn: the XMP sidecars that go with a moved photo", () => {
  const dir = path.join(path.sep, "Volumes", "home", "card");
  const at = (...names: string[]) => names.map((n) => path.join(dir, n));
  const go = (names: string[], members: string[]) => sidecarsIn(dir, names, at(...members));

  it.each([
    ["stem.xmp", ["IMG_1.CR3", "IMG_1.xmp"], ["IMG_1.CR3"], ["IMG_1.xmp"]],
    ["full name, Lightroom and darktable style", ["IMG_1.CR3", "IMG_1.CR3.xmp"], ["IMG_1.CR3"], ["IMG_1.CR3.xmp"]],
    ["full name in lower case", ["IMG_1.CR3", "IMG_1.cr3.xmp"], ["IMG_1.CR3"], ["IMG_1.cr3.xmp"]],
    ["a JPG's own", ["IMG_1.jpg", "IMG_1.jpg.xmp"], ["IMG_1.jpg"], ["IMG_1.jpg.xmp"]],
    ["an upper-case extension", ["IMG_1.NEF", "IMG_1.XMP"], ["IMG_1.NEF"], ["IMG_1.XMP"]],
    [
      "a RAW and its JPG, each with its own and a shared one",
      ["IMG_1.CR3", "IMG_1.jpg", "IMG_1.CR3.xmp", "IMG_1.jpg.xmp", "IMG_1.xmp"],
      ["IMG_1.CR3", "IMG_1.jpg"],
      ["IMG_1.CR3.xmp", "IMG_1.jpg.xmp", "IMG_1.xmp"],
    ],
    // A case-insensitive drive (exFAT, SMB) lists a name in another case than the import used.
    ["names differing only in case", ["img_1.cr3", "Img_1.Xmp"], ["IMG_1.CR3"], ["Img_1.Xmp"]],
  ])("%s", (_label, names, members, expected) => {
    expect(go(names, members)).toEqual(at(...expected));
  });

  it("leaves sidecars of files that aren't moving, and other files' look-alikes", () => {
    const names = ["IMG_1.jpg", "IMG_2.CR3", "IMG_2.xmp", "IMG_10.xmp", "IMG_1.CR3.xmp", "._IMG_1.xmp", "notes.xmp"];
    // IMG_1.CR3.xmp names a RAW that isn't here: it isn't the JPG's.
    expect(go(names, ["IMG_1.jpg"])).toEqual([]);
  });

  it("keeps everything when a photo of the same name stays behind", () => {
    expect(go(["IMG_1.jpg", "IMG_1.CR3", "IMG_1.xmp"], ["IMG_1.jpg"])).toBe("partner_stays");
    expect(go(["IMG_1.CR3", "IMG_1.MOV"], ["IMG_1.CR3"])).toBe("partner_stays");
  });

  it("a same-named file Lifer can't import never holds a photo back", () => {
    expect(go(["IMG_1.CR3", "IMG_1.THM", "IMG_1.xmp"], ["IMG_1.CR3"])).toEqual(at("IMG_1.xmp"));
  });

  it("a sidecar whose name is another file's full name belongs to that file", () => {
    // IMG_1.CR3.jpg (an export) shares the stem "IMG_1.CR3" with the RAW's sidecar.
    expect(go(["IMG_1.CR3", "IMG_1.CR3.jpg", "IMG_1.CR3.xmp"], ["IMG_1.CR3.jpg"])).toEqual([]);
  });
});
