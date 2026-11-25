// The upright sRGB JPEG that stands in for a photo sharp can't decode, or can't decode in the right
// colours (DECODED_FORMATS).
import type { PhotoFormat } from "./formats.js";
import { avifToJpegBuffer, avifToJpegFile } from "./avif.js";
import { heicToJpegBuffer, heicToJpegFile } from "./heic.js";
import { jp2ToJpegBuffer, jp2ToJpegFile } from "./jp2.js";
import { jxlToJpegBuffer, jxlToJpegFile } from "./jxl.js";

const DECODERS: Partial<
  Record<
    PhotoFormat,
    {
      buffer: (input: string | Uint8Array) => Promise<Buffer>;
      file: (input: string, dest: string) => Promise<{ width: number; height: number }>;
    }
  >
> = {
  heic: { buffer: heicToJpegBuffer, file: heicToJpegFile },
  avif: { buffer: avifToJpegBuffer, file: avifToJpegFile },
  jp2: { buffer: jp2ToJpegBuffer, file: jp2ToJpegFile },
  jxl: { buffer: jxlToJpegBuffer, file: jxlToJpegFile },
};

export function decodedJpegBuffer(format: PhotoFormat, input: string | Uint8Array): Promise<Buffer> {
  return DECODERS[format]!.buffer(input);
}

export function decodedJpegFile(
  format: PhotoFormat,
  input: string,
  dest: string,
): Promise<{ width: number; height: number }> {
  return DECODERS[format]!.file(input, dest);
}
