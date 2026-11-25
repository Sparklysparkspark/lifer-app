// Which photo files Lifer accepts and how each is treated: the one place upload routes, the trip
// importer and the web app's accept lists take their answer from.
import { open } from "node:fs/promises";
import path from "node:path";

export type PhotoFormat = "jpeg" | "png" | "webp" | "tiff" | "heic" | "avif" | "jp2" | "jxl";

interface FormatInfo {
  mimeTypes: string[];
  extensions: string[];
  /** Used when the upload's own name has no usable extension. */
  defaultExtension: string;
  /** Browsers can show it, so the import screen needs no preview from the server. */
  browserViewable: boolean;
}

export const PHOTO_FORMATS: Record<PhotoFormat, FormatInfo> = {
  jpeg: {
    mimeTypes: ["image/jpeg", "image/jpg", "image/pjpeg"],
    extensions: [".jpg", ".jpeg", ".jpe"],
    defaultExtension: ".jpg",
    browserViewable: true,
  },
  png: { mimeTypes: ["image/png"], extensions: [".png"], defaultExtension: ".png", browserViewable: true },
  webp: { mimeTypes: ["image/webp"], extensions: [".webp"], defaultExtension: ".webp", browserViewable: true },
  tiff: {
    mimeTypes: ["image/tiff", "image/tif", "image/x-tiff"],
    extensions: [".tif", ".tiff"],
    defaultExtension: ".tif",
    browserViewable: false,
  },
  heic: {
    mimeTypes: ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"],
    extensions: [".heic", ".heif", ".hif"],
    defaultExtension: ".heic",
    browserViewable: false,
  },
  // Not shown directly: the desktop's webview on older macOS and Linux can't decode AVIF.
  avif: { mimeTypes: ["image/avif"], extensions: [".avif"], defaultExtension: ".avif", browserViewable: false },
  // JPEG 2000: the JP2/JPX file format and bare codestreams (.j2k, .j2c). Only Safari shows it.
  jp2: {
    mimeTypes: ["image/jp2", "image/jpx"],
    extensions: [".jp2", ".jpf", ".jpx", ".j2k", ".j2c"],
    defaultExtension: ".jp2",
    browserViewable: false,
  },
  // JPEG XL: Safari shows it, other browsers and the webviews don't.
  jxl: { mimeTypes: ["image/jxl"], extensions: [".jxl"], defaultExtension: ".jxl", browserViewable: false },
};

/** Formats read through an upright sRGB JPEG made from them (decodedJpeg.ts): sharp can't decode
 *  HEIC, JPEG 2000 or JPEG XL, and reads an AVIF's colours wrong when it isn't sRGB. */
export const DECODED_FORMATS: ReadonlySet<PhotoFormat> = new Set<PhotoFormat>(["heic", "avif", "jp2", "jxl"]);

/** Every accepted edited-photo MIME type, mapped to the extension a file of that type is stored
 *  with when its own name has none. */
export const ACCEPTED_PHOTO_TYPES: Record<string, string> = Object.fromEntries(
  Object.values(PHOTO_FORMATS).flatMap((f) => f.mimeTypes.map((m) => [m, f.defaultExtension])),
);

export const ACCEPTED_PHOTO_EXTENSIONS: string[] = Object.values(PHOTO_FORMATS).flatMap((f) => f.extensions);

// Camera RAW extensions. A .tif/.tiff is a RAW only when its content says so (isRawFile).
export const VENDOR_RAW_EXTENSIONS = new Set([
  ".cr2",
  ".cr3",
  ".nef",
  ".nrw",
  ".arw",
  ".raf",
  ".rw2",
  ".orf",
  ".dng",
  ".pef",
  ".srw",
]);
const TIFF_EXTENSIONS = new Set(PHOTO_FORMATS.tiff.extensions);

// Browsers send "" or application/octet-stream for types they don't know (HEIC on most desktops).
const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

function extOf(name: string): string {
  return path.extname(name).toLowerCase();
}

/** The photo format a MIME type ("image/heic") or a file name ("IMG_1.HEIC") stands for. */
export function photoFormatFor(nameOrMime: string): PhotoFormat | null {
  const value = nameOrMime.trim().toLowerCase();
  const mime = value.split(";")[0].trim();
  const entries = Object.entries(PHOTO_FORMATS) as [PhotoFormat, FormatInfo][];
  return (
    entries.find(([, info]) => info.mimeTypes.includes(mime))?.[0] ??
    entries.find(([, info]) => info.extensions.includes(extOf(value)))?.[0] ??
    null
  );
}

/** The format an upload claims: its MIME type, or its name when the browser didn't know the type. */
export function claimedPhotoFormat(
  mimetype: string | null | undefined,
  filename: string | null | undefined,
): PhotoFormat | null {
  const mime = (mimetype ?? "").trim().toLowerCase();
  if (!GENERIC_MIME_TYPES.has(mime)) return photoFormatFor(mime);
  return filename ? photoFormatFor(filename) : null;
}

/** True for a name that may be a RAW: a camera RAW extension or a TIFF (which needs isRawFile). */
export function isRawExtension(name: string): boolean {
  const ext = extOf(name);
  return VENDOR_RAW_EXTENSIONS.has(ext) || TIFF_EXTENSIONS.has(ext);
}

/** The extension to store a photo with: the upload's own when it matches the real format
 *  (".tiff" stays ".tiff"), else the format's default. JPEGs keep being stored as ".jpg". */
export function storedPhotoExtension(format: PhotoFormat, uploadedName: string | null): string {
  if (format === "jpeg") return ".jpg";
  // Stryker disable next-line StringLiteral: equivalent, any non-extension stand-in falls through to the default extension
  const own = uploadedName ? extOf(uploadedName) : "";
  return PHOTO_FORMATS[format].extensions.includes(own) ? own : PHOTO_FORMATS[format].defaultExtension;
}

async function readHead(filePath: string, length: number, position = 0): Promise<Buffer> {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

export function isHeicBytes(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  const box = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (box.toString("latin1", 4, 8) !== "ftyp") return false;
  const major = box.toString("latin1", 8, 12);
  // "mif1" is also AVIF's base brand; sharp reads AVIF itself, so it isn't HEIC here.
  if (major === "avif" || major === "avis") return false;
  // Stryker disable next-line MethodExpression: equivalent, toString clamps the end to the buffer length
  if (major === "mif1" || major === "msf1")
    return !box.toString("latin1", 16, Math.min(box.length, 64)).includes("avif");
  return HEIF_BRANDS.has(major);
}

// JP2 signature box, then the ftyp box's brand. "jpm " (compound documents) isn't a photo.
const JP2_SIGNATURE = Buffer.from([0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);
const JP2_BRANDS = new Set(["jp2 ", "jpx "]);
// SOC then SIZ marker: a bare JPEG 2000 codestream.
const J2K_CODESTREAM = Buffer.from([0xff, 0x4f, 0xff, 0x51]);

export function isJp2Bytes(head: Uint8Array): boolean {
  const box = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (box.length >= 4 && box.subarray(0, 4).equals(J2K_CODESTREAM)) return true;
  if (box.length < 24 || !box.subarray(0, 12).equals(JP2_SIGNATURE)) return false;
  return box.toString("latin1", 16, 20) === "ftyp" && JP2_BRANDS.has(box.toString("latin1", 20, 24));
}

// A bare JPEG XL codestream, or the ISO BMFF container's signature box.
const JXL_CODESTREAM = Buffer.from([0xff, 0x0a]);
const JXL_CONTAINER = Buffer.from([0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);

export function isJxlBytes(head: Uint8Array): boolean {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  return (
    (b.length >= 2 && b.subarray(0, 2).equals(JXL_CODESTREAM)) ||
    (b.length >= 12 && b.subarray(0, 12).equals(JXL_CONTAINER))
  );
}

function isAvifBytes(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  const box = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (box.toString("latin1", 4, 8) !== "ftyp") return false;
  const major = box.toString("latin1", 8, 12);
  if (major === "avif" || major === "avis") return true;
  // A mif1/msf1 file is AVIF when its compatible brands say so (see isHeicBytes).
  return (major === "mif1" || major === "msf1") && !isHeicBytes(head);
}

/** sniffPhotoFormat for bytes already read: the first 64 of the file. */
export function sniffPhotoBytes(head: Uint8Array): PhotoFormat | null {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "png";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b.length >= 4 && (b.toString("latin1", 0, 4) === "II*\0" || b.toString("latin1", 0, 4) === "MM\0*"))
    return "tiff";
  if (isHeicBytes(b)) return "heic";
  if (isAvifBytes(b)) return "avif";
  if (isJp2Bytes(b)) return "jp2";
  if (isJxlBytes(b)) return "jxl";
  return null;
}

/** The format a file really is, from its first bytes, or null when it's none Lifer reads as a
 *  photo. */
export async function sniffPhotoFormat(filePath: string): Promise<PhotoFormat | null> {
  return sniffPhotoBytes(await readHead(filePath, 64));
}

// PhotometricInterpretation values of unprocessed sensor data: Color Filter Array (a Bayer
// mosaic) and LinearRaw (DNG's demosaiced but unrendered data).
const RAW_PHOTOMETRICS = new Set([32803, 34892]);
const TAG_PHOTOMETRIC = 262;
const TAG_SUB_IFDS = 330;
const MAX_IFDS = 16;

/** PhotometricInterpretation of every image in a TIFF (IFD chain and SubIFDs), read from the
 *  header only. A camera often keeps the sensor data in a SubIFD behind an RGB thumbnail. */
export async function tiffPhotometrics(filePath: string): Promise<number[]> {
  const fh = await open(filePath, "r");
  try {
    const read = async (pos: number, len: number) => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return buf.subarray(0, bytesRead);
    };
    const header = await read(0, 8);
    if (header.length < 8) return [];
    const order = header.toString("latin1", 0, 2);
    if (order !== "II" && order !== "MM") return [];
    const le = order === "II";
    const u16 = (b: Buffer, o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const u32 = (b: Buffer, o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    if (u16(header, 2) !== 42) return []; // BigTIFF and others: not classified here
    const found: number[] = [];
    const queue = [u32(header, 4)];
    const seen = new Set<number>();
    while (queue.length > 0 && seen.size < MAX_IFDS) {
      const offset = queue.shift()!;
      if (!offset || seen.has(offset)) continue;
      seen.add(offset);
      const countBuf = await read(offset, 2);
      if (countBuf.length < 2) continue;
      const count = Math.min(u16(countBuf, 0), 1000);
      const entries = await read(offset + 2, count * 12 + 4);
      for (let i = 0; i < count && (i + 1) * 12 <= entries.length; i++) {
        const e = i * 12;
        const tag = u16(entries, e);
        const type = u16(entries, e + 2);
        const n = u32(entries, e + 4);
        if (tag === TAG_PHOTOMETRIC) found.push(type === 3 ? u16(entries, e + 8) : u32(entries, e + 8));
        else if (tag === TAG_SUB_IFDS && (type === 4 || type === 13)) {
          if (n === 1) queue.push(u32(entries, e + 8));
          else if (n > 1) {
            const list = await read(u32(entries, e + 8), Math.min(n, MAX_IFDS) * 4);
            for (let j = 0; j + 4 <= list.length; j += 4) queue.push(u32(list, j));
          }
        }
      }
      if (entries.length >= count * 12 + 4) queue.push(u32(entries, count * 12));
    }
    return found;
  } finally {
    await fh.close();
  }
}

/** A TIFF holding sensor data (Color Filter Array or LinearRaw) is a RAW; any other TIFF is an
 *  edited photo. */
async function isRawTiff(filePath: string): Promise<boolean> {
  try {
    return (await tiffPhotometrics(filePath)).some((p) => RAW_PHOTOMETRICS.has(p));
  } catch {
    return false;
  }
}

/** Whether a file is a camera RAW: by extension, or for a TIFF by its content. `name` is the
 *  original file name when `filePath` is a temp file without it. */
export async function isRawFile(filePath: string, name: string = filePath): Promise<boolean> {
  const ext = extOf(name);
  if (VENDOR_RAW_EXTENSIONS.has(ext)) return true;
  if (TIFF_EXTENSIONS.has(ext)) return isRawTiff(filePath);
  return false;
}

/** "raw", "photo" (an edited photo Lifer accepts) or null, from the name and the content. */
export async function photoKindFor(filePath: string, name: string = filePath): Promise<"raw" | "photo" | null> {
  if (await isRawFile(filePath, name)) return "raw";
  // Stryker disable next-line ArrowFunction: equivalent, undefined and null are both "not a photo" here
  return (await sniffPhotoFormat(filePath).catch(() => null)) ? "photo" : null;
}
