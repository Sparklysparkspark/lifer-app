// The upright JPEG that stands in for a photo sharp can't decode (DECODED_FORMATS).
import type { PhotoFormat } from "./formats.js";
import { heicToJpegBuffer, heicToJpegFile } from "./heic.js";
import { jp2ToJpegBuffer, jp2ToJpegFile } from "./jp2.js";

export function decodedJpegBuffer(format: PhotoFormat, input: string | Uint8Array): Promise<Buffer> {
  return format === "jp2" ? jp2ToJpegBuffer(input) : heicToJpegBuffer(input);
}

export function decodedJpegFile(
  format: PhotoFormat,
  input: string,
  dest: string,
): Promise<{ width: number; height: number }> {
  return format === "jp2" ? jp2ToJpegFile(input, dest) : heicToJpegFile(input, dest);
}
