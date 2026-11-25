// AVIF decoding for previews and matching. sharp reads AVIF and applies an ICC profile in one, but
// ignores the colour primaries an nclx box states, so the working JPEG made here is converted to
// sRGB from those (heifColour.ts). Config-free, so the inference worker can use it too.
import sharp from "sharp";
import { maxImagePixels } from "../lib/imageLimits.js";
import { nclxToSrgb, readHeifColour } from "./heifColour.js";

/** The AVIF's primary image as sRGB, upright (libheif applies irot/imir) and with no metadata, so
 *  nothing turns it again. A gain map is ignored: this is the SDR base. */
async function avifToSrgb(input: string | Uint8Array) {
  const colour = await readHeifColour(input);
  const image = sharp(input, { limitInputPixels: maxImagePixels() });
  return (colour && "primaries" in colour ? nclxToSrgb(image, colour.primaries) : image)
    .toColourspace("srgb")
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" });
}

/** Decodes an AVIF into sRGB JPEG bytes. */
export async function avifToJpegBuffer(input: string | Uint8Array): Promise<Buffer> {
  return (await avifToSrgb(input)).toBuffer();
}

/** Decodes an AVIF into an sRGB JPEG at `dest`. */
export async function avifToJpegFile(input: string, dest: string): Promise<{ width: number; height: number }> {
  const info = await (await avifToSrgb(input)).toFile(dest);
  return { width: info.width, height: info.height };
}
