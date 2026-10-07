import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import {
  ACCEPTED_PHOTO_EXTENSIONS,
  ACCEPTED_PHOTO_TYPES,
  PHOTO_FORMATS,
  VENDOR_RAW_EXTENSIONS,
  claimedPhotoFormat,
  isHeicBytes,
  isHeicFile,
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
  buf.writeUInt16LE(262, 10);
  buf.writeUInt16LE(3, 12);
  buf.writeUInt32LE(1, 14);
  buf.writeUInt16LE(2, 18);
  buf.writeUInt16LE(330, 22);
  buf.writeUInt16LE(4, 24);
  buf.writeUInt32LE(1, 26);
  buf.writeUInt32LE(40, 30);
  buf.writeUInt32LE(0, 34);
  // SubIFD at 40: PhotometricInterpretation CFA.
  buf.writeUInt16LE(1, 40);
  buf.writeUInt16LE(262, 42);
  buf.writeUInt16LE(3, 44);
  buf.writeUInt32LE(1, 46);
  buf.writeUInt16LE(32803, 50);
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
    expect(ACCEPTED_PHOTO_EXTENSIONS).toEqual(
      expect.arrayContaining([".jpg", ".png", ".webp", ".tif", ".tiff", ".heic", ".heif"]),
    );
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

type IfdEntry = [tag: number, type: number, count: number, value: number];

// A TIFF laid out by hand: each IFD at a given offset, with its entries and the offset of the next
// one. A SHORT (type 3) value sits in the first two bytes of the value field, as the spec says.
function buildTiff(opts: {
  le: boolean;
  ifds: Array<{ at: number; entries: IfdEntry[]; next?: number }>;
  lists?: Array<{ at: number; values: number[] }>;
  size?: number;
  magic?: number;
  order?: string;
}): Buffer {
  const buf = Buffer.alloc(opts.size ?? 1024);
  const u16 = (v: number, o: number) => (opts.le ? buf.writeUInt16LE(v, o) : buf.writeUInt16BE(v, o));
  const u32 = (v: number, o: number) => (opts.le ? buf.writeUInt32LE(v, o) : buf.writeUInt32BE(v, o));
  buf.write(opts.order ?? (opts.le ? "II" : "MM"), 0, "latin1");
  u16(opts.magic ?? 42, 2);
  u32(opts.ifds[0]?.at ?? 0, 4);
  for (const ifd of opts.ifds) {
    u16(ifd.entries.length, ifd.at);
    ifd.entries.forEach(([tag, type, count, value], i) => {
      const e = ifd.at + 2 + i * 12;
      u16(tag, e);
      u16(type, e + 2);
      u32(count, e + 4);
      if (type === 3) u16(value, e + 8);
      else u32(value, e + 8);
    });
    u32(ifd.next ?? 0, ifd.at + 2 + ifd.entries.length * 12);
  }
  for (const list of opts.lists ?? []) list.values.forEach((v, i) => u32(v, list.at + i * 4));
  return buf;
}

const PHOTOMETRIC = 262;
const SUB_IFDS = 330;
const SHORT = 3;
const LONG = 4;
const IFD = 13;
const CFA = 32803;
const LINEAR_RAW = 34892;
const RGB = 2;

describe("tiffPhotometrics", () => {
  it("reads big-endian TIFFs", async () => {
    const p = await write(
      "be.tif",
      buildTiff({ le: false, ifds: [{ at: 8, entries: [[PHOTOMETRIC, SHORT, 1, CFA]] }] }),
    );
    expect(await tiffPhotometrics(p)).toEqual([CFA]);
    expect(await isRawFile(p)).toBe(true);
  });

  it("reads PhotometricInterpretation stored as a LONG as well as a SHORT", async () => {
    for (const le of [true, false]) {
      const p = await write(
        `long-${le}.tif`,
        buildTiff({ le, ifds: [{ at: 8, entries: [[PHOTOMETRIC, LONG, 1, CFA]] }] }),
      );
      expect(await tiffPhotometrics(p)).toEqual([CFA]);
    }
  });

  it("follows the chain of images", async () => {
    const p = await write(
      "chain.tif",
      buildTiff({
        le: true,
        ifds: [
          { at: 8, entries: [[PHOTOMETRIC, SHORT, 1, RGB]], next: 40 },
          { at: 40, entries: [[PHOTOMETRIC, SHORT, 1, CFA]] },
        ],
      }),
    );
    expect(await tiffPhotometrics(p)).toEqual([RGB, CFA]);
  });

  it("stops at an image that points back at itself", async () => {
    const p = await write(
      "loop.tif",
      buildTiff({ le: true, ifds: [{ at: 8, entries: [[PHOTOMETRIC, SHORT, 1, RGB]], next: 8 }] }),
    );
    expect(await tiffPhotometrics(p)).toEqual([RGB]);
  });

  it("reads at most 16 images from a long chain", async () => {
    const ifds = Array.from({ length: 20 }, (_, i) => ({
      at: 8 + i * 20,
      entries: [[PHOTOMETRIC, SHORT, 1, 100 + i]] as IfdEntry[],
      next: i < 19 ? 8 + (i + 1) * 20 : 0,
    }));
    const p = await write("long-chain.tif", buildTiff({ le: true, ifds }));
    expect(await tiffPhotometrics(p)).toEqual(Array.from({ length: 16 }, (_, i) => 100 + i));
  });

  it("reads a list of SubIFDs, stored as the IFD type", async () => {
    const p = await write(
      "sublist.tif",
      buildTiff({
        le: true,
        ifds: [
          {
            at: 8,
            entries: [
              [PHOTOMETRIC, SHORT, 1, RGB],
              [SUB_IFDS, IFD, 2, 200],
            ],
          },
          { at: 40, entries: [[PHOTOMETRIC, SHORT, 1, CFA]] },
          { at: 70, entries: [[PHOTOMETRIC, SHORT, 1, LINEAR_RAW]] },
          { at: 100, entries: [[PHOTOMETRIC, SHORT, 1, 5]] },
        ],
        // A third offset follows the two the tag declares; it isn't part of the list.
        lists: [{ at: 200, values: [40, 70, 100] }],
      }),
    );
    expect(await tiffPhotometrics(p)).toEqual([RGB, CFA, LINEAR_RAW]);
  });

  it("only treats the SubIFDs tag, with an offset type, as a pointer to more images", async () => {
    // ImageWidth (256) and a SHORT-typed SubIFDs both hold 60, where a CFA directory sits that
    // nothing really points to.
    const p = await write(
      "not-sub.tif",
      buildTiff({
        le: true,
        ifds: [
          {
            at: 8,
            entries: [
              [PHOTOMETRIC, SHORT, 1, RGB],
              [256, LONG, 1, 60],
              [SUB_IFDS, SHORT, 1, 60],
            ],
          },
          { at: 60, entries: [[PHOTOMETRIC, SHORT, 1, CFA]] },
        ],
      }),
    );
    expect(await tiffPhotometrics(p)).toEqual([RGB]);
    expect(await isRawFile(p)).toBe(false);
  });

  it("reads what it can of a truncated image directory, without throwing", async () => {
    // The directory claims three entries, but the file ends right after the first.
    const full = buildTiff({
      le: true,
      ifds: [
        {
          at: 8,
          entries: [
            [PHOTOMETRIC, SHORT, 1, CFA],
            [1, SHORT, 1, 0],
            [2, SHORT, 1, 0],
          ],
        },
      ],
    });
    const p = await write("truncated.tif", full.subarray(0, 8 + 2 + 12));
    expect(await tiffPhotometrics(p)).toEqual([CFA]);
  });

  it("doesn't throw when the file ends inside the pointer to the next directory", async () => {
    const full = buildTiff({ le: true, ifds: [{ at: 8, entries: [[PHOTOMETRIC, SHORT, 1, CFA]] }] });
    const p = await write("cut-next.tif", full.subarray(0, 8 + 2 + 12 + 2));
    expect(await tiffPhotometrics(p)).toEqual([CFA]);
  });

  it("returns nothing for a directory past the end of the file", async () => {
    const p = await write(
      "past-end.tif",
      buildTiff({ le: true, ifds: [{ at: 1000, entries: [] }], size: 1100 }).subarray(0, 100),
    );
    expect(await tiffPhotometrics(p)).toEqual([]);
  });

  it("returns nothing for files that aren't a classic TIFF", async () => {
    const tooShort = await write("short.tif", Buffer.from("II*\0", "latin1"));
    const badOrder = await write(
      "order.tif",
      buildTiff({ le: false, order: "XX", ifds: [{ at: 8, entries: [[PHOTOMETRIC, SHORT, 1, CFA]] }] }),
    );
    const bigTiff = await write(
      "big.tif",
      buildTiff({ le: true, magic: 43, ifds: [{ at: 8, entries: [[PHOTOMETRIC, SHORT, 1, CFA]] }] }),
    );
    for (const p of [tooShort, badOrder, bigTiff]) expect(await tiffPhotometrics(p)).toEqual([]);
  });
});

describe("accepted photo types", () => {
  // What uploads may claim, and the extension a file of that type gets when its name has none.
  const accepted: Record<string, [format: string, extension: string]> = {
    "image/jpeg": ["jpeg", ".jpg"],
    "image/jpg": ["jpeg", ".jpg"],
    "image/pjpeg": ["jpeg", ".jpg"],
    "image/png": ["png", ".png"],
    "image/webp": ["webp", ".webp"],
    "image/tiff": ["tiff", ".tif"],
    "image/tif": ["tiff", ".tif"],
    "image/x-tiff": ["tiff", ".tif"],
    "image/heic": ["heic", ".heic"],
    "image/heif": ["heic", ".heic"],
    "image/heic-sequence": ["heic", ".heic"],
    "image/heif-sequence": ["heic", ".heic"],
  };

  it.each(Object.entries(accepted))("accepts %s", (mime, [format, extension]) => {
    expect(photoFormatFor(mime)).toBe(format);
    expect(ACCEPTED_PHOTO_TYPES[mime]).toBe(extension);
  });

  it("accepts nothing else", () => {
    expect(Object.keys(ACCEPTED_PHOTO_TYPES).sort()).toEqual(Object.keys(accepted).sort());
  });

  it.each([
    ["a.jpg", "jpeg"],
    ["a.JPEG", "jpeg"],
    ["a.jpe", "jpeg"],
    ["a.png", "png"],
    ["a.webp", "webp"],
    ["a.tif", "tiff"],
    ["a.heic", "heic"],
    ["a.heif", "heic"],
    ["a.hif", "heic"],
  ])("knows %s by its name", (name, format) => {
    expect(photoFormatFor(name)).toBe(format);
  });

  it("lists the type uploads are sent as first", () => {
    // migrateToServer uploads with mimeTypes[0], so it has to be the standard name.
    expect(Object.fromEntries(Object.entries(PHOTO_FORMATS).map(([f, info]) => [f, info.mimeTypes[0]]))).toEqual({
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      tiff: "image/tiff",
      heic: "image/heic",
    });
  });

  it("only asks the server for a preview of formats browsers can't show", () => {
    const viewable = Object.entries(PHOTO_FORMATS)
      .filter(([, info]) => info.browserViewable)
      .map(([f]) => f);
    expect(viewable.sort()).toEqual(["jpeg", "png", "webp"]);
  });

  it("ignores case, surrounding spaces and MIME parameters", () => {
    expect(photoFormatFor("  IMAGE/HEIC  ")).toBe("heic");
    expect(photoFormatFor("image/heic ; charset=binary")).toBe("heic");
    expect(photoFormatFor(" IMG_1.HEIC ")).toBe("heic");
  });

  it("falls back to the name for every generic type a browser sends, and for no type at all", () => {
    for (const generic of ["", "application/octet-stream", "binary/octet-stream", " application/octet-stream "]) {
      expect(claimedPhotoFormat(generic, "IMG_1.heic")).toBe("heic");
    }
    expect(claimedPhotoFormat(null, "IMG_1.heic")).toBe("heic");
    expect(claimedPhotoFormat(undefined, null)).toBeNull();
  });

  // Canon, Nikon, Sony, Fujifilm, Panasonic, Olympus, Adobe DNG, Pentax, Samsung.
  it.each([".cr2", ".cr3", ".nef", ".nrw", ".arw", ".raf", ".rw2", ".orf", ".dng", ".pef", ".srw"])(
    "treats %s as a camera RAW by its name",
    async (ext) => {
      expect(VENDOR_RAW_EXTENSIONS.has(ext)).toBe(true);
      expect(isRawExtension(`IMG_1${ext.toUpperCase()}`)).toBe(true);
      expect(await isRawFile(path.join(dir, "missing"), `IMG_1${ext}`)).toBe(true);
    },
  );

  it("doesn't treat a name without an extension, or a photo's, as a RAW", async () => {
    expect(isRawExtension("IMG_1")).toBe(false);
    expect(await isRawFile(await write("plain.jpg", await base().jpeg().toBuffer()))).toBe(false);
  });

  it("judges a TIFF by content only when it's named as a TIFF", async () => {
    const cfa = await write("cfa-named.bin", setTiffPhotometric(await base().tiff().toBuffer(), CFA));
    expect(await isRawFile(cfa, "IMG_1.tif")).toBe(true);
    expect(await isRawFile(cfa, "IMG_1.jpg")).toBe(false);
    // A TIFF name whose file can't be read isn't a RAW, and doesn't throw.
    expect(await isRawFile(path.join(dir, "gone.tif"))).toBe(false);
  });
});

// An ISO base media file's first box: size, "ftyp", major brand, minor version, compatible brands.
function ftyp(major: string, compatible: string[] = []): Buffer {
  const body = Buffer.from(["ftyp", major, "\0\0\0\0", ...compatible].join(""), "latin1");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length + 4);
  return Buffer.concat([size, body]);
}

describe("isHeicBytes", () => {
  it.each(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"])(
    "knows the %s brand",
    (brand) => {
      expect(isHeicBytes(ftyp(brand, ["miaf"]))).toBe(true);
    },
  );

  it("leaves AVIF to sharp, whether it says so in the major or a compatible brand", () => {
    expect(isHeicBytes(ftyp("avif"))).toBe(false);
    expect(isHeicBytes(ftyp("avis"))).toBe(false);
    expect(isHeicBytes(ftyp("mif1", ["miaf", "avif"]))).toBe(false);
    expect(isHeicBytes(ftyp("msf1", ["avif"]))).toBe(false);
  });

  it("needs a whole ftyp header", () => {
    expect(isHeicBytes(ftyp("heic").subarray(0, 12))).toBe(true);
    expect(isHeicBytes(ftyp("heic").subarray(0, 11))).toBe(false);
    const notFtyp = ftyp("heic");
    notFtyp.write("free", 4, "latin1");
    expect(isHeicBytes(notFtyp)).toBe(false);
    expect(isHeicBytes(ftyp("mp42"))).toBe(false);
  });

  it("reads the bytes it was given, not the whole buffer behind them", () => {
    const shared = Buffer.concat([Buffer.from("padding!"), ftyp("heic")]);
    expect(isHeicBytes(shared.subarray(8))).toBe(true);
  });
});

describe("sniffPhotoFormat", () => {
  it("knows each format from its first bytes alone", async () => {
    const files: Array<[string, Buffer, string | null]> = [
      ["jpeg", Buffer.from([0xff, 0xd8, 0xff]), "jpeg"],
      ["png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "png"],
      ["webp", Buffer.from("RIFF\0\0\0\0WEBP", "latin1"), "webp"],
      ["tiff-le", Buffer.from("II*\0", "latin1"), "tiff"],
      ["tiff-be", Buffer.from("MM\0*", "latin1"), "tiff"],
      ["heic", ftyp("heic", ["mif1"]), "heic"],
    ];
    for (const [name, bytes, format] of files)
      expect(await sniffPhotoFormat(await write(`sniff-${name}`, bytes))).toBe(format);
  });

  it("wants every byte of the signature", async () => {
    const nearMisses = [
      Buffer.from([0x00, 0xd8, 0xff]),
      Buffer.from([0xff, 0x00, 0xff]),
      Buffer.from([0xff, 0xd8, 0x00]),
      Buffer.from([0xff, 0xd8]),
      Buffer.from("RIFF\0\0\0\0WAVE", "latin1"),
      Buffer.from("RIFX\0\0\0\0WEBP", "latin1"),
      Buffer.from("MM*\0", "latin1"),
    ];
    for (const [i, bytes] of nearMisses.entries())
      expect(await sniffPhotoFormat(await write(`miss-${i}`, bytes))).toBeNull();
  });

  it("isHeicFile reads the file's own header", async () => {
    expect(await isHeicFile(await write("h.heic", ftyp("heic")))).toBe(true);
    expect(await isHeicFile(await write("h.jpg", await base().jpeg().toBuffer()))).toBe(false);
  });

  it("closes every file it opens", async () => {
    const tiff = await write("fd.tif", await base().tiff().toBuffer());
    const openFiles = () => readdirSync("/dev/fd").length;
    const before = openFiles();
    for (let i = 0; i < 20; i++) {
      await sniffPhotoFormat(tiff);
      await tiffPhotometrics(tiff);
    }
    expect(openFiles()).toBeLessThan(before + 5);
  });
});
