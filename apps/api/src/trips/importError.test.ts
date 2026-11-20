import { describe, expect, it } from "vitest";
import { plainImportError } from "./importError.js";

describe("plainImportError", () => {
  it("names a corrupt JPEG plainly instead of passing libvips' text on", () => {
    const vips = new Error(
      "Input file has corrupt header: VipsJpeg: Corrupt JPEG data: 227 extraneous bytes before marker 0xee\nVipsJpeg: premature end of JPEG image",
    );
    expect(plainImportError(vips)).toBe("This photo is damaged and can't be read");
  });

  it("turns file-system codes into plain reasons", () => {
    const denied = Object.assign(new Error("EACCES: permission denied, open '/x.jpg'"), { code: "EACCES" });
    expect(plainImportError(denied)).toBe("Lifer isn't allowed to open this file");
    const gone = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    expect(plainImportError(gone)).toBe("File not found");
  });

  it("keeps Lifer's own short messages and hides anything else raw", () => {
    expect(plainImportError(new Error("Unknown species"))).toBe("Unknown species");
    expect(plainImportError(new Error("exiftool crashed"))).toBe("Lifer couldn't import this file");
    expect(plainImportError(new Error("x".repeat(200)))).toBe("Lifer couldn't import this file");
  });
});
