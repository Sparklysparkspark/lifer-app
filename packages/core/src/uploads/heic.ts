// HEIC/HEIF decoding via heic-decode (wasm), since sharp's bundled libheif has no HEVC decoder.
// The original is never changed; a decoded JPEG stands in wherever pixels are needed.
// Config-free, so the inference worker can use it too.
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import sharp from "sharp";
import { createLimiter } from "../lib/concurrency.js";
import { heifColour, nclxToSrgb, pngWithIcc, type HeifColour } from "./heifColour.js";

type Decoded = { width: number; height: number; data: Uint8ClampedArray };
type HeicDecode = (input: { buffer: Uint8Array }) => Promise<Decoded>;

const require = createRequire(import.meta.url);
let decoder: HeicDecode | null = null;
// Loaded on first use: the wasm bundle is about 2 MB of JavaScript.
const heicDecode = (): HeicDecode => (decoder ??= require("heic-decode") as HeicDecode);

// The wasm decoder needs the whole file in memory, then the full RGBA image (a 48 MP phone photo
// is ~190 MB of pixels), so decodes run one at a time and oversized files are refused.
const MAX_HEIC_FILE_BYTES = 512 * 1024 * 1024;
const decodeLimit = createLimiter(1);

// Quality of the working JPEG that previews and species matching read. High, since it's the
// only full-resolution decode Lifer makes of the photo.
const HEIC_WORKING_JPEG_QUALITY = 92;

type DecodedHeic = { data: Buffer; width: number; height: number; colour: HeifColour | null };

/** Upright RGBA pixels of a HEIC's primary image, and the colour space they're in. libheif applies
 *  the file's rotation and mirror (irot/imir) itself, so the result must not be rotated again from
 *  the EXIF Orientation. */
async function decodeHeic(input: string | Uint8Array): Promise<DecodedHeic> {
  return decodeLimit(async () => {
    let bytes: Uint8Array;
    if (typeof input === "string") {
      if ((await stat(input)).size > MAX_HEIC_FILE_BYTES)
        throw Object.assign(new Error("That HEIC file is too large to decode"), { statusCode: 413 });
      bytes = await readFile(input);
    } else bytes = input;
    const { width, height, data } = await heicDecode()({ buffer: bytes });
    const colour = heifColour(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return { data: Buffer.from(data.buffer, data.byteOffset, data.byteLength), width, height, colour };
  });
}

async function jpegFrom({ data, width, height, colour }: DecodedHeic) {
  // heic-decode applies no colour profile, so the pixels are brought to sRGB here.
  const image =
    colour && "icc" in colour
      ? sharp(await pngWithIcc(data, { width, height }, colour.icc), { limitInputPixels: false })
      : sharp(data, { raw: { width, height, channels: 4 }, limitInputPixels: false });
  // Flattened onto white: a HEIC's alpha (rare) has no meaning in a JPEG. No metadata is copied,
  // so no Orientation tag can turn the already upright pixels again.
  const flat = image.flatten({ background: "#ffffff" });
  return (colour && "primaries" in colour ? nclxToSrgb(flat, colour.primaries) : flat)
    .toColourspace("srgb")
    .jpeg({ quality: HEIC_WORKING_JPEG_QUALITY, chromaSubsampling: "4:4:4" });
}

/** Decodes a HEIC into an upright JPEG at `dest`. */
export async function heicToJpegFile(input: string, dest: string): Promise<{ width: number; height: number }> {
  const decoded = await decodeHeic(input);
  await (await jpegFrom(decoded)).toFile(dest);
  return { width: decoded.width, height: decoded.height };
}

/** Decodes a HEIC into upright JPEG bytes. */
export async function heicToJpegBuffer(input: string | Uint8Array): Promise<Buffer> {
  return (await jpegFrom(await decodeHeic(input))).toBuffer();
}
