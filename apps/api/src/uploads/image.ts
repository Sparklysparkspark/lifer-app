// Derivative generation via sharp/libvips. The app always renders from display_path — the
// original upload buffer is discarded after this runs; only the display/thumb copies are kept.
import { writeFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import sharp from "sharp";
import { APP_DATA_DIR } from "../config.js";
import { ensureDir } from "../lib/safeFs.js";

const execFileAsync = promisify(execFile);
// The package is plain CJS (`module.exports = <value>`, no `.default`): ffmpeg-static's own
// published .d.ts declares an ESM `export default` that doesn't actually match its CJS runtime
// shape, which trips up NodeNext+esModuleInterop's default-import synthesis. `require` sidesteps
// the mismatch entirely instead of fighting the package's own (incorrect) types.
const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static") as string;

const DISPLAY_WIDTH = 2560;
const THUMB_WIDTH = 400;
// Grid tiles on a high-density screen; see photos/routes.ts mediumDerivative.
const MEDIUM_WIDTH = 1024;
// Reference photos (species-level, not a user's own capture) get a much
// smaller display size than a user's own trophy shot: nobody zooms into a reference photo
// the way they would their own upload, it's just "what does this species look like" on a
// card/detail hero. 1200px keeps it sharp on any real screen while roughly halving storage
// versus the full 2560px user-upload size across ~80,000 species worth of downloads.
const REFERENCE_DISPLAY_WIDTH = 1200;
const REFERENCE_THUMB_WIDTH = 400;

export interface DerivativePaths {
  displayPath: string;
  thumbPath: string;
  /** Auto-oriented (EXIF-rotated) source dimensions — the aspect ratio every derivative
   *  actually renders at. Used to size a masonry grid tile before the image itself has
   *  loaded, instead of guessing (see MasonryGrid.tsx). */
  width: number | null;
  height: number | null;
}

// Under APP_DATA_DIR, not DATA_DIR — these are disposable, regenerable-from-the-original
// caches, not part of the user's own portable library (the thing "Storage location" in
// Settings is about). Keeping them out of DATA_DIR means moving your library to a new folder
// only moves what you'd actually recognize as your photos, not internal derivative junk
// alongside it — and matches generateReferenceDerivatives below, which already followed this
// same rule for the shared species-reference cache.
export async function generateDerivatives(buffer: Buffer, photoId: string): Promise<DerivativePaths> {
  const displayDir = path.join(APP_DATA_DIR, "display");
  const thumbDir = path.join(APP_DATA_DIR, "thumb");
  await ensureDir(displayDir);
  await ensureDir(thumbDir);

  const displayPath = path.join(displayDir, `${photoId}.webp`);
  const thumbPath = path.join(thumbDir, `${photoId}.webp`);

  // Decoded once (auto-oriented from EXIF, resized to display size), then encoded to each size
  // in parallel: decoding a 24MP JPEG twice, at WebP's default effort, was most of the 350ms
  // this took per photo. Effort 2 is about twice as fast for files about 7% bigger. The 1,024px
  // grid copy is made here too, so a new photo never waits for photos/routes.ts to make one.
  const decoded = await sharp(buffer).rotate().resize({ width: DISPLAY_WIDTH, withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
  const fromDecoded = () => sharp(decoded.data, { raw: decoded.info });
  const mediumDir = path.join(APP_DATA_DIR, "medium");
  await ensureDir(mediumDir);
  // The output info (not the source's metadata) has the real, EXIF-rotated dimensions, which is
  // what a masonry tile needs for its aspect ratio.
  const [displayInfo] = await Promise.all([
    fromDecoded().webp({ quality: 85, effort: 2 }).toFile(displayPath),
    fromDecoded().resize({ width: MEDIUM_WIDTH, withoutEnlargement: true }).webp({ quality: 80, effort: 2 }).toFile(path.join(mediumDir, `${photoId}.webp`)),
    fromDecoded().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 80, effort: 2 }).toFile(thumbPath),
  ]);
  // Written in parallel, the medium copy can land a moment before the display image, which would
  // make photos/routes.ts think it's out of date and remake it.
  const now = new Date();
  await utimes(path.join(mediumDir, `${photoId}.webp`), now, now);

  return { displayPath, thumbPath, width: displayInfo.width ?? null, height: displayInfo.height ?? null };
}

export interface VideoDerivativePaths extends DerivativePaths {
  durationSeconds: number | null;
  /** Only set when the source wasn't already natively web-playable — null means the original
   *  file itself is H.264/AAC-in-MP4 and gets served directly for in-app playback, same
   *  zero-extra-cost path as an already-web-safe upload. */
  previewPath: string | null;
}

// ffmpeg's own DECODE support isn't the constraint here — it reads nearly any codec/container a
// camera or phone could produce. The constraint is PLAYBACK: Lightbox's <video> element is
// decoded by whichever browser engine the current platform's webview embeds, and H.264/AAC-in-
// MP4 is the one combination that plays back reliably everywhere. Anything else (HEVC, ProRes,
// an MKV/WebM with an unsupported codec) gets a transcoded, playback-safe copy generated
// alongside the untouched original — never rejected outright, never silently re-encoded when
// it's already fine.
//
// Read from ffmpeg's own description of the file ("ffmpeg -i"), not ffprobe: the ffprobe-static
// package's Apple Silicon build is actually an Intel binary, so on an Apple Silicon Mac without
// Rosetta every video import and video species check failed. ffmpeg-static's build is native.
export async function probeVideo(filePath: string): Promise<{ durationSeconds: number | null; isWebSafe: boolean }> {
  if (!ffmpegPath) throw new Error("ffmpeg binary not found: reinstall dependencies");
  // With no output file ffmpeg exits with an error after printing the description; that's expected.
  const stderr = await execFileAsync(ffmpegPath, ["-hide_banner", "-i", filePath], { maxBuffer: 1024 * 1024 * 8 }).then(
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
  const videoCodec = /Stream #\d+:\d+[^:]*: Video: (\w+)/.exec(text)?.[1] ?? null;
  const audioCodec = /Stream #\d+:\d+[^:]*: Audio: (\w+)/.exec(text)?.[1] ?? null;
  const isWebSafe = formats.includes("mp4") && videoCodec === "h264" && (audioCodec === null || audioCodec === "aac");
  return { durationSeconds: durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null, isWebSafe };
}

/** Grabs one raw JPEG frame at an arbitrary timestamp — shared by the poster-frame extraction
 *  below and captures/routes.ts's video species-suggestion endpoint (which needs several
 *  frames spread across a clip, not just the one-poster-frame case this file otherwise only
 *  ever needed). No sharp resize step here (unlike the poster path) — a suggestion is scored
 *  by the ML model at its own fixed input size regardless of the frame's original resolution,
 *  so resizing first would just be wasted work. */
export async function extractVideoFrame(filePath: string, atSeconds: number): Promise<Buffer> {
  if (!ffmpegPath) throw new Error("ffmpeg binary not found — reinstall dependencies");
  const { stdout } = await execFileAsync(
    ffmpegPath,
    ["-y", "-ss", String(atSeconds), "-i", filePath, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 64 },
  );
  return stdout as unknown as Buffer;
}

// Under APP_DATA_DIR, same "disposable, regenerable-from-the-original" rule as the image
// derivatives above — the poster and (when generated) the transcoded preview can always be
// rebuilt from the original video file in `originals`, so neither belongs in the user's own
// portable DATA_DIR library folder.
export async function generateVideoDerivatives(filePath: string, photoId: string): Promise<VideoDerivativePaths> {
  // Only null if ffmpeg-static's postinstall genuinely failed to fetch a binary for this
  // platform — bundled unconditionally (see this file's own module-level import), so this is a
  // real installation problem, not something to silently degrade around.
  if (!ffmpegPath) throw new Error("ffmpeg binary not found — reinstall dependencies");
  const displayDir = path.join(APP_DATA_DIR, "display");
  const thumbDir = path.join(APP_DATA_DIR, "thumb");
  const previewDir = path.join(APP_DATA_DIR, "video-preview");
  await ensureDir(displayDir);
  await ensureDir(thumbDir);

  const { durationSeconds, isWebSafe } = await probeVideo(filePath);

  // Poster frame ~1s in (a cleaner representative frame than the very first, which is
  // sometimes still black/fading in on real camera footage) — extracted as a PNG on ffmpeg's
  // stdout, then piped through the exact same sharp resize/webp steps generateDerivatives
  // already uses for thumb/display, so a video's card looks identical in every other way to a
  // photo's.
  const { stdout: posterPng } = await execFileAsync(
    ffmpegPath,
    ["-y", "-ss", "1", "-i", filePath, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 64 },
  );

  const displayPath = path.join(displayDir, `${photoId}.webp`);
  const thumbPath = path.join(thumbDir, `${photoId}.webp`);
  const image = sharp(posterPng as unknown as Buffer).rotate();
  const displayInfo = await image.clone().resize({ width: DISPLAY_WIDTH, withoutEnlargement: true }).webp({ quality: 85 }).toFile(displayPath);
  await image.clone().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 80 }).toFile(thumbPath);

  let previewPath: string | null = null;
  if (!isWebSafe) {
    await ensureDir(previewDir);
    previewPath = path.join(previewDir, `${photoId}.mp4`);
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i",
      filePath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      previewPath,
    ]);
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

// Same shape as generateDerivatives above, under APP_DATA_DIR (a shared species-reference
// cache, not part of any one photo library) and keyed by species/gallery-photo id rather than
// a photos.id. Width-only resize, full aspect preserved — never bakes a crop into the stored
// file, since a baked-in crop can't be recovered later without re-fetching the source, and an
// automatic attention-region heuristic isn't reliable enough to trust unsupervised across the
// whole catalog. Instead the full image stays on disk and the crop is stored as data
// (species.reference_focal_x/y, migration 043) applied at render time — same model
// CardCropEditor.tsx uses for a user's own cover photo.
export async function generateReferenceDerivatives(buffer: Buffer, key: string): Promise<{ displayPath: string; thumbPath: string }> {
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
