// JPEG XL decoding via jxl-oxide (WebAssembly), since sharp's libvips has no libjxl. The decoder
// renders in sRGB from whatever colour space the file uses, with the file's orientation applied,
// and ignores a gain map (the SDR base is what's shown). Config-free, so the inference worker can
// use it too.
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import { createLimiter } from "../lib/concurrency.js";
import { maxImagePixels } from "../lib/imageLimits.js";

type JxlModule = typeof import("jxl-oxide-wasm");

const MAX_JXL_FILE_BYTES = 512 * 1024 * 1024;
// The decoder holds the whole file and frame in memory, so decodes run one at a time.
// shortcut: its WebAssembly memory stays at the largest photo's size until the process exits;
// decode in a child process if very large JXLs turn up.
const decodeLimit = createLimiter(1);

let loading: Promise<JxlModule> | null = null;
// Loaded on first use, from the package's own .wasm file.
function decoder(): Promise<JxlModule> {
  return (loading ??= (async () => {
    const mod = await import("jxl-oxide-wasm");
    const dir = path.dirname(createRequire(import.meta.url).resolve("jxl-oxide-wasm/package.json"));
    mod.initSync({ module: await readFile(path.join(dir, "jxl_oxide_wasm_bg.wasm")) });
    return mod;
  })());
}

function damaged(): Error {
  return Object.assign(new Error("This photo is damaged and can't be read"), { statusCode: 400 });
}

/** The upright image of a JPEG XL file (its first frame) as PNG bytes: in sRGB, or with
 *  `ownColours` in the file's own colour space (16-bit, stated in a cICP chunk or ICC profile), as
 *  the HDR rendition needs. A bare codestream decodes too, as a gain map is stored. */
export async function decodeJxl(input: string | Uint8Array, { ownColours = false } = {}): Promise<Buffer> {
  if (typeof input === "string" && (await stat(input)).size > MAX_JXL_FILE_BYTES)
    throw Object.assign(new Error("That JPEG XL file is too large to decode"), { statusCode: 413 });
  const { JxlImage } = await decoder();
  return decodeLimit(async () => {
    const image = new JxlImage();
    try {
      image.forceSrgb = !ownColours;
      image.feedBytes(typeof input === "string" ? await readFile(input) : input);
      // A truncated file can still render a partial frame; it's refused instead.
      if (!image.tryInit() || !image.loaded) throw damaged();
      const limit = maxImagePixels();
      if (limit && (image.width ?? 0) * (image.height ?? 0) > limit)
        throw Object.assign(new Error("That JPEG XL photo is too large to decode"), { statusCode: 413 });
      // encodeToPng consumes the render result, freeing it.
      return Buffer.from(image.render().encodeToPng());
    } catch (err) {
      throw (err as { statusCode?: number }).statusCode ? err : damaged();
    } finally {
      image.free();
    }
  });
}

function jpegFrom(png: Buffer) {
  return sharp(png, { limitInputPixels: false }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" });
}

/** Decodes a JPEG XL file into upright JPEG bytes. */
export async function jxlToJpegBuffer(input: string | Uint8Array): Promise<Buffer> {
  return jpegFrom(await decodeJxl(input)).toBuffer();
}

/** Decodes a JPEG XL file into an upright JPEG at `dest`. */
export async function jxlToJpegFile(input: string, dest: string): Promise<{ width: number; height: number }> {
  const info = await jpegFrom(await decodeJxl(input)).toFile(dest);
  return { width: info.width, height: info.height };
}
