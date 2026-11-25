import { describe, expect, it } from "vitest";
import { isBrowserDisplayable, isVideoFile, photoFormatOf, PHOTO_ACCEPT } from "./photoFormats";
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
    expect(photoFormatOf(f("a.avif", "image/avif"))).toBe("avif");
    expect(photoFormatOf(f("scan.JP2"))).toBe("jp2");
    expect(photoFormatOf(f("tile.j2k", "application/octet-stream"))).toBe("jp2");
    expect(photoFormatOf(f("a.jpx", "image/jpx"))).toBe("jp2");
    expect(photoFormatOf(f("DSC_1.JXL"))).toBe("jxl");
    expect(photoFormatOf(f("a.jxl", "image/jxl"))).toBe("jxl");
  });

  it("accepts AVIF, JPEG 2000 and JPEG XL in the file pickers", () => {
    for (const v of ["image/avif", ".avif", "image/jp2", ".jp2", ".jpf", ".jpx", ".j2k", ".j2c", "image/jxl", ".jxl"])
      expect(PHOTO_ACCEPT.split(",")).toContain(v);
  });

  it("only JPEG, PNG and WebP display straight from the file", () => {
    expect(isBrowserDisplayable(f("a.png", "image/png"))).toBe(true);
    expect(isBrowserDisplayable(f("a.webp", "image/webp"))).toBe(true);
    expect(isBrowserDisplayable(f("a.tif", "image/tiff"))).toBe(false);
    expect(isBrowserDisplayable(f("a.heic"))).toBe(false);
    expect(isBrowserDisplayable(f("a.avif", "image/avif"))).toBe(false);
    expect(isBrowserDisplayable(f("a.jp2", "image/jp2"))).toBe(false);
    expect(isBrowserDisplayable(f("a.jxl", "image/jxl"))).toBe(false);
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
