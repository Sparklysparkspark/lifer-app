// Derivative generation via sharp/libvips. The app renders from these WebP copies, never from the
// original.
import { utimes } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import sharp from "sharp";
import { APP_DATA_DIR } from "../config.js";
import { ensureDir } from "../lib/safeFs.js";
import { createLimiter } from "../lib/concurrency.js";
import { originalSharpOptions } from "../lib/imageLimits.js";
import { isHeicBytes, isHeicFile } from "./formats.js";
import { heicToJpegBuffer } from "./heic.js";

const execFileAsync = promisify(execFile);
// ffmpeg-static is plain CJS but its types declare an ESM default export, so it's loaded with
// require.
const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static") as string;

// Uploads are only mp4/mov, so ffmpeg may read local files through the MP4-family demuxer and
// nothing else: a crafted file can't make it open URLs, playlists or other demuxers.
const FFMPEG_INPUT_RESTRICTIONS = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2"];
const FRAME_TIMEOUT_MS = 60_000;
const TRANSCODE_TIMEOUT_MS = 15 * 60_000;
// Each ffmpeg process can use several cores and a lot of memory; more than two at once starves the API.
const ffmpegLimit = createLimiter(2);

function runFfmpeg(args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return ffmpegLimit(() =>
    execFileAsync(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 8, timeout, killSignal: "SIGKILL" }),
  );
}

function runFfmpegToBuffer(args: string[], timeout: number): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return ffmpegLimit(() =>
    execFileAsync(ffmpegPath, args, {
      encoding: "buffer",
      maxBuffer: 1024 * 1024 * 64,
      timeout,
      killSignal: "SIGKILL",
    }),
  );
}

const DISPLAY_WIDTH = 2560;
const THUMB_WIDTH = 400;
// Grid tiles on a high-density screen; see photos/routes.ts mediumDerivative.
const MEDIUM_WIDTH = 1024;
// Reference photos aren't zoomed into like your own, so 1200 px is sharp enough and saves storage.
const REFERENCE_DISPLAY_WIDTH = 1200;
const REFERENCE_THUMB_WIDTH = 400;

export interface DerivativePaths {
  displayPath: string;
  thumbPath: string;
  /** Auto-oriented (EXIF-rotated) dimensions, so a masonry tile is sized before the image loads
   *  (MasonryGrid.tsx). */
  width: number | null;
  height: number | null;
}

/** What sharp should open for a photo: the file or bytes themselves, or for a HEIC (which sharp
 *  can't decode) an upright JPEG made from it. */
async function decodableImage(image: Buffer | string): Promise<Buffer | string> {
  const heic = typeof image === "string" ? await isHeicFile(image) : isHeicBytes(image.subarray(0, 64));
  return heic ? heicToJpegBuffer(image) : image;
}

// Under APP_DATA_DIR, not DATA_DIR: these are regenerable caches, not part of the portable library.
// Pass a path rather than bytes where possible, so sharp streams instead of holding the whole photo.
export async function generateDerivatives(image: Buffer | string, photoId: string): Promise<DerivativePaths> {
  const displayDir = path.join(APP_DATA_DIR, "display");
  const thumbDir = path.join(APP_DATA_DIR, "thumb");
  await ensureDir(displayDir);
  await ensureDir(thumbDir);

  const displayPath = path.join(displayDir, `${photoId}.webp`);
  const thumbPath = path.join(thumbDir, `${photoId}.webp`);

  // Decoded once, then encoded to each size in parallel. WebP effort 2 trades slightly bigger
  // files for speed. The 1,024 px grid copy is made here so a new photo never waits for one.
  const decoded = await sharp(await decodableImage(image), originalSharpOptions())
    .rotate()
    .resize({ width: DISPLAY_WIDTH, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const fromDecoded = () => sharp(decoded.data, { raw: decoded.info });
  const mediumDir = path.join(APP_DATA_DIR, "medium");
  await ensureDir(mediumDir);
  // The output info (not the source's metadata) has the real, EXIF-rotated dimensions, which is
  // what a masonry tile needs for its aspect ratio.
  const [displayInfo] = await Promise.all([
    fromDecoded().webp({ quality: 85, effort: 2 }).toFile(displayPath),
    fromDecoded()
      .resize({ width: MEDIUM_WIDTH, withoutEnlargement: true })
      .webp({ quality: 80, effort: 2 })
      .toFile(path.join(mediumDir, `${photoId}.webp`)),
    fromDecoded()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 80, effort: 2 })
      .toFile(thumbPath),
  ]);
  // Written in parallel, the medium copy can land a moment before the display image, which would
  // make photos/routes.ts think it's out of date and remake it.
  const now = new Date();
  await utimes(path.join(mediumDir, `${photoId}.webp`), now, now);

  return { displayPath, thumbPath, width: displayInfo.width ?? null, height: displayInfo.height ?? null };
}

export interface VideoDerivativePaths extends DerivativePaths {
  durationSeconds: number | null;
  /** A playback copy, only when the original isn't H.264/AAC in MP4. Null means the original is
   *  served directly. */
  previewPath: string | null;
}

// H.264/AAC in MP4 is the one format every platform's webview plays, so anything else gets a
// transcoded playback copy next to the untouched original.
// Read from "ffmpeg -i" rather than ffprobe: ffprobe-static's Apple Silicon build is an Intel binary.
export async function probeVideo(filePath: string): Promise<{ durationSeconds: number | null; isWebSafe: boolean }> {
  if (!ffmpegPath) throw new Error("ffmpeg binary not found: reinstall dependencies");
  // With no output file ffmpeg exits with an error after printing the description; that's expected.
  const stderr = await runFfmpeg(["-hide_banner", ...FFMPEG_INPUT_RESTRICTIONS, "-i", filePath], FRAME_TIMEOUT_MS).then(
    (r) => String(r.stderr),
    (err: { stderr?: string | Buffer }) => String(err.stderr ?? ""),
  );
  return parseFfmpegDescription(stderr);
}

/** Duration and playback safety from `ffmpeg -i` output. Exported for tests. */
export function parseFfmpegDescription(text: string): { durationSeconds: number | null; isWebSafe: boolean } {
  const input = /^Input #0, ([^,\n]+(?:,[^,\n]+)*), from /m.exec(text);
  if (!input) throw new Error("ffmpeg couldn't read this video");
  const formats = input[1].split(",").map((f) => f.trim());
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const durationSeconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null;
  const videoStream = /Stream #\d+:\d+[^:]*: Video: ([^\n]*)/.exec(text)?.[1] ?? "";
  const videoCodec = /^(\w+)/.exec(videoStream)?.[1] ?? null;
  // 10-bit or 4:2:2 H.264 (some cameras' "10-bit" modes) is still h264 but won't play in a
  // browser, so only 8-bit 4:2:0 counts.
  const pixelFormat = /, (yuvj?4\d\dp\w*|yuv\w+|nv\w+|gray\w*)[(,]/.exec(videoStream)?.[1] ?? null;
  const audioCodec = /Stream #\d+:\d+[^:]*: Audio: (\w+)/.exec(text)?.[1] ?? null;
  const isWebSafe =
    formats.includes("mp4") &&
    videoCodec === "h264" &&
    (pixelFormat === "yuv420p" || pixelFormat === "yuvj420p") &&
    (audioCodec === null || audioCodec === "aac");
  return {
    durationSeconds:
      durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
    isWebSafe,
  };
}

/** One JPEG frame at a timestamp, for video species suggestions. Not resized: the model resizes
 *  to its own input anyway. */
export async function extractVideoFrame(filePath: string, atSeconds: number): Promise<Buffer> {
  if (!ffmpegPath) throw new Error("ffmpeg binary not found: reinstall dependencies");
  const { stdout } = await runFfmpegToBuffer(
    [
      "-y",
      "-ss",
      String(atSeconds),
      ...FFMPEG_INPUT_RESTRICTIONS,
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-",
    ],
    FRAME_TIMEOUT_MS,
  );
  return stdout;
}

// Under APP_DATA_DIR like the image derivatives: the poster and preview can be rebuilt from the
// original.
export async function generateVideoDerivatives(filePath: string, photoId: string): Promise<VideoDerivativePaths> {
  // Null only when ffmpeg-static's install failed to fetch a binary: a real installation problem.
  if (!ffmpegPath) throw new Error("ffmpeg binary not found: reinstall dependencies");
  const displayDir = path.join(APP_DATA_DIR, "display");
  const thumbDir = path.join(APP_DATA_DIR, "thumb");
  const previewDir = path.join(APP_DATA_DIR, "video-preview");
  await ensureDir(displayDir);
  await ensureDir(thumbDir);

  const { durationSeconds, isWebSafe } = await probeVideo(filePath);

  // Poster frame about 1 s in (the first is often still black), then the same resize and WebP
  // steps as a photo.
  const { stdout: posterPng } = await runFfmpegToBuffer(
    [
      "-y",
      "-ss",
      "1",
      ...FFMPEG_INPUT_RESTRICTIONS,
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-",
    ],
    FRAME_TIMEOUT_MS,
  );

  const displayPath = path.join(displayDir, `${photoId}.webp`);
  const thumbPath = path.join(thumbDir, `${photoId}.webp`);
  const image = sharp(posterPng).rotate();
  const displayInfo = await image
    .clone()
    .resize({ width: DISPLAY_WIDTH, withoutEnlargement: true })
    .webp({ quality: 85 })
    .toFile(displayPath);
  await image.clone().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 80 }).toFile(thumbPath);

  let previewPath: string | null = null;
  if (!isWebSafe) {
    await ensureDir(previewDir);
    previewPath = path.join(previewDir, `${photoId}.mp4`);
    await runFfmpeg(
      [
        "-y",
        ...FFMPEG_INPUT_RESTRICTIONS,
        "-i",
        filePath,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        // 8-bit 4:2:0, the only H.264 browsers and the desktop webview play. Without it a 10-bit
        // source (iPhone HDR, ProRes) gives a High 10 preview that won't play.
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        previewPath,
      ],
      TRANSCODE_TIMEOUT_MS,
    );
  }

  return {
    displayPath,
    thumbPath,
    width: displayInfo.width ?? null,
    height: displayInfo.height ?? null,
    durationSeconds,
    previewPath,
  };
}

// The shared species-reference cache, keyed by species or gallery-photo id. Width-only resize: the
// crop is stored as data (reference_focal_x/y) and applied at render time.
export async function generateReferenceDerivatives(
  buffer: Buffer,
  key: string,
): Promise<{ displayPath: string; thumbPath: string }> {
  const displayDir = path.join(APP_DATA_DIR, "reference-display");
  const thumbDir = path.join(APP_DATA_DIR, "reference-thumb");
  await ensureDir(displayDir);
  await ensureDir(thumbDir);

  const displayPath = path.join(displayDir, `${key}.webp`);
  const thumbPath = path.join(thumbDir, `${key}.webp`);

  const image = sharp(buffer).rotate();

  await image
    .clone()
    .resize({ width: REFERENCE_DISPLAY_WIDTH, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(displayPath);

  await image
    .clone()
    .resize({ width: REFERENCE_THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(thumbPath);

  return { displayPath, thumbPath };
}
