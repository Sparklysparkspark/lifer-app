import { describe, expect, it } from "vitest";
import { isBrowserDisplayable, isVideoFile, photoFormatOf } from "./photoFormats";
import { isRawFile, RAW_EXTENSIONS } from "./rawExtensions";

const f = (name: string, type = "") => ({ name, type });

describe("photo formats", () => {
  it("goes by MIME type, or by extension when the browser didn't know the type", () => {
    expect(photoFormatOf(f("a.jpg", "image/jpeg"))).toBe("jpeg");
    expect(photoFormatOf(f("IMG_1.HEIC"))).toBe("heic");
    expect(photoFormatOf(f("IMG_1.hif", "application/octet-stream"))).toBe("heic");
    expect(photoFormatOf(f("scan.tiff", "image/tiff"))).toBe("tiff");
    expect(photoFormatOf(f("x.webp", "image/webp"))).toBe("webp");
    expect(photoFormatOf(f("anim.gif", "image/gif"))).toBeNull();
  });

  it("only JPEG, PNG and WebP display straight from the file", () => {
    expect(isBrowserDisplayable(f("a.png", "image/png"))).toBe(true);
    expect(isBrowserDisplayable(f("a.webp", "image/webp"))).toBe(true);
    expect(isBrowserDisplayable(f("a.tif", "image/tiff"))).toBe(false);
    expect(isBrowserDisplayable(f("a.heic"))).toBe(false);
  });

  it("treats a TIFF as a photo, not a RAW, though the RAW pickers still offer it", () => {
    expect(isRawFile("edit.tif")).toBe(false);
    expect(isRawFile("DSC_1.NEF")).toBe(true);
    expect(RAW_EXTENSIONS.has(".tif")).toBe(true);
  });

  it("recognizes videos by type or extension", () => {
    expect(isVideoFile(f("clip.MOV"))).toBe(true);
    expect(isVideoFile(f("clip", "video/mp4"))).toBe(true);
    expect(isVideoFile(f("a.jpg", "image/jpeg"))).toBe(false);
  });
});
