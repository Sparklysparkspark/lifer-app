// JPEG 2000 decoding via the bundled ffmpeg's native decoder, since sharp's libvips has no
// OpenJPEG. The original is never changed; a decoded JPEG stands in wherever pixels are needed.
// Config-free, so the inference worker can use it too.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import sharp from "sharp";
import { createLimiter } from "../lib/concurrency.js";
import { maxImagePixels } from "../lib/imageLimits.js";

// Loaded on first use, so the inference-only sidecar never needs ffmpeg unless it meets a JP2.
const ffmpegPath = () => createRequire(import.meta.url)("ffmpeg-static") as string;

const MAX_JP2_FILE_BYTES = 512 * 1024 * 1024;
// A separate process, killed on a timeout, so a hostile file can't hang or exhaust the API.
const DECODE_TIMEOUT_MS = 2 * 60_000;
const MAX_JPEG_BYTES = 512 * 1024 * 1024;
const decodeLimit = createLimiter(1);

function damaged(): Error {
  return Object.assign(new Error("This photo is damaged and can't be read"), { statusCode: 400 });
}

/** Runs ffmpeg's decoder on a JPEG 2000 file (JP2, JPX or a bare codestream), writing a JPEG
 *  to `dest`, or to stdout (returned) without one.
 *  shortcut: an EXIF Orientation exiftool put in a JP2's uuid box is ignored (cameras don't make
 *  JP2), read it with exiftool here if rotated JP2s ever turn up. */
async function decodeJp2(input: string | Uint8Array, dest?: string): Promise<Buffer> {
  if (typeof input === "string" && (await stat(input)).size > MAX_JP2_FILE_BYTES)
    throw Object.assign(new Error("That JPEG 2000 file is too large to decode"), { statusCode: 413 });
  const limit = maxImagePixels();
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    // Only the JPEG 2000 reader, from a local file or stdin, whatever the file claims to be.
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    "j2k_pipe",
    "-f",
    "j2k_pipe",
    "-c:v",
    "jpeg2000",
    ...(limit ? ["-max_pixels", String(Math.min(limit, 2 ** 31 - 1))] : []),
    "-i",
    typeof input === "string" ? `file:${input}` : "pipe:0",
    "-frames:v",
    "1",
    // 4:4:4 at high quality, like the HEIC working JPEG: the only full-size decode Lifer makes.
    "-pix_fmt",
    "yuvj444p",
    "-q:v",
    "2",
    "-vcodec",
    "mjpeg",
    ...(dest ? ["-y", "-f", "image2", "-update", "1", `file:${dest}`] : ["-f", "image2pipe", "pipe:1"]),
  ];
  return decodeLimit(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        const child = execFile(
          ffmpegPath(),
          args,
          { encoding: "buffer", maxBuffer: MAX_JPEG_BYTES, timeout: DECODE_TIMEOUT_MS, killSignal: "SIGKILL" },
          // ffmpeg can exit 0 with no frame for a file it couldn't decode.
          (err, stdout) => (err || (!dest && stdout.length === 0) ? reject(damaged()) : resolve(stdout)),
        );
        // ffmpeg may stop reading stdin early when it rejects the file.
        child.stdin?.on("error", () => {});
        child.stdin?.end(typeof input === "string" ? undefined : input);
      }),
  );
}

/** Decodes a JPEG 2000 file into JPEG bytes. */
export function jp2ToJpegBuffer(input: string | Uint8Array): Promise<Buffer> {
  return decodeJp2(input);
}

/** Decodes a JPEG 2000 file into a JPEG at `dest`. */
export async function jp2ToJpegFile(input: string, dest: string): Promise<{ width: number; height: number }> {
  await decodeJp2(input, dest);
  const { width, height } = await sharp(dest)
    .metadata()
    .catch(() => ({ width: 0, height: 0 }));
  if (!width || !height) throw damaged();
  return { width, height };
}
