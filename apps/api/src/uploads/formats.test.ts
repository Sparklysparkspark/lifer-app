import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import {
  ACCEPTED_PHOTO_EXTENSIONS,
  ACCEPTED_PHOTO_TYPES,
  claimedPhotoFormat,
  isRawExtension,
  isRawFile,
  photoFormatFor,
  photoKindFor,
  sniffPhotoFormat,
  storedPhotoExtension,
  tiffPhotometrics,
} from "./formats.js";
import { setTiffPhotometric } from "./testImages.js";

const dir = mkdtempSync(path.join(tmpdir(), "lifer-formats-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function write(name: string, bytes: Buffer): Promise<string> {
  const p = path.join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

const base = () => sharp({ create: { width: 16, height: 12, channels: 3, background: "#336699" } });

// A little-endian TIFF whose IFD0 is an RGB thumbnail and whose one SubIFD holds CFA data, the
// layout cameras use for sensor-data TIFFs.
function tiffWithCfaSubIfd(): Buffer {
  const buf = Buffer.alloc(200);
  buf.write("II", 0);
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(8, 4);
  // IFD0 at 8: PhotometricInterpretation RGB, SubIFDs -> 40.
  buf.writeUInt16LE(2, 8);
  buf.writeUInt16LE(262, 10), buf.writeUInt16LE(3, 12), buf.writeUInt32LE(1, 14), buf.writeUInt16LE(2, 18);
  buf.writeUInt16LE(330, 22), buf.writeUInt16LE(4, 24), buf.writeUInt32LE(1, 26), buf.writeUInt32LE(40, 30);
  buf.writeUInt32LE(0, 34);
  // SubIFD at 40: PhotometricInterpretation CFA.
  buf.writeUInt16LE(1, 40);
  buf.writeUInt16LE(262, 42), buf.writeUInt16LE(3, 44), buf.writeUInt32LE(1, 46), buf.writeUInt16LE(32803, 50);
  buf.writeUInt32LE(0, 54);
  return buf;
}

describe("photo formats", () => {
  it("maps MIME types and names to formats", () => {
    expect(photoFormatFor("image/heic")).toBe("heic");
    expect(photoFormatFor("image/webp")).toBe("webp");
    expect(photoFormatFor("IMG_0001.HEIF")).toBe("heic");
    expect(photoFormatFor("/x/y/scan.tiff")).toBe("tiff");
    expect(photoFormatFor("image/gif")).toBeNull();
    // Browsers send no type for HEIC on most desktops: the name decides then.
    expect(claimedPhotoFormat("", "IMG_1.heic")).toBe("heic");
    expect(claimedPhotoFormat("application/octet-stream", "IMG_1.webp")).toBe("webp");
    expect(claimedPhotoFormat("image/gif", "IMG_1.jpg")).toBeNull();
    expect(ACCEPTED_PHOTO_TYPES["image/heic"]).toBe(".heic");
    expect(ACCEPTED_PHOTO_EXTENSIONS).toEqual(expect.arrayContaining([".jpg", ".png", ".webp", ".tif", ".tiff", ".heic", ".heif"]));
  });

  it("keeps a matching extension and stores JPEGs as .jpg", () => {
    expect(storedPhotoExtension("tiff", "scan.TIFF")).toBe(".tiff");
    expect(storedPhotoExtension("tiff", "scan.jpg")).toBe(".tif");
    expect(storedPhotoExtension("jpeg", "a.jpeg")).toBe(".jpg");
    expect(storedPhotoExtension("heic", null)).toBe(".heic");
  });

  it("sniffs formats from content", async () => {
    expect(await sniffPhotoFormat(await write("a", await base().jpeg().toBuffer()))).toBe("jpeg");
    expect(await sniffPhotoFormat(await write("b", await base().png().toBuffer()))).toBe("png");
    expect(await sniffPhotoFormat(await write("c", await base().webp().toBuffer()))).toBe("webp");
    expect(await sniffPhotoFormat(await write("d", await base().tiff().toBuffer()))).toBe("tiff");
    expect(await sniffPhotoFormat(await write("e", await base().avif().toBuffer()))).toBeNull();
    expect(await sniffPhotoFormat(await write("f", Buffer.from("not an image")))).toBeNull();
  });

  it("tells a sensor-data TIFF from an edited one", async () => {
    const edited = await write("edited.tif", await base().tiff().toBuffer());
    const cfa = await write("cfa.tif", setTiffPhotometric(await base().tiff().toBuffer(), 32803));
    const linear = await write("linear.tiff", setTiffPhotometric(await base().tiff().toBuffer(), 34892));
    const sub = await write("sub.tif", tiffWithCfaSubIfd());
    expect(await tiffPhotometrics(sub)).toEqual([2, 32803]);
    expect(await isRawFile(edited)).toBe(false);
    expect(await isRawFile(cfa)).toBe(true);
    expect(await isRawFile(linear)).toBe(true);
    expect(await isRawFile(sub)).toBe(true);
    expect(await photoKindFor(edited)).toBe("photo");
    expect(await photoKindFor(cfa)).toBe("raw");
    // A camera RAW by its extension, whatever the bytes; the name wins over a temp path.
    expect(await isRawFile(edited, "IMG_1.CR3")).toBe(true);
    expect(isRawExtension("x.NEF")).toBe(true);
    expect(isRawExtension("x.tif")).toBe(true);
    expect(isRawExtension("x.jpg")).toBe(false);
  });
});
