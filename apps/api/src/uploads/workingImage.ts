// The images an import reads besides the untouched original: what sharp decodes for previews
// (a HEIC becomes an upright JPEG) and what species matching reads (a huge panorama gets a
// smaller copy). Temp files live in the upload temp folder and are removed by release().
import { rm } from "node:fs/promises";
import sharp from "sharp";
import { INFERENCE_SOURCE_MAX_PIXELS, originalSharpOptions } from "../lib/imageLimits.js";
import type { PhotoFormat } from "./formats.js";
import { heicToJpegFile } from "./heic.js";
import { uploadTempPath } from "./common.js";

// A panorama's matching copy: big enough for the detector's tiles to find a small bird.
const INFERENCE_COPY_PIXELS = 64_000_000;
const INFERENCE_COPY_QUALITY = 92;
// The import screen's preview for a file a browser can't show (TIFF, HEIC).
const PREVIEW_WIDTH = 1600;

export interface WorkingImage {
  /** Opened by sharp for derivatives: the original, or the decoded JPEG for a HEIC. */
  decodePath: string;
  /** Read by species matching (the original unless a copy was needed). */
  inferencePath: string;
  /** True when inferencePath is the original's own bytes, so vectors a client computed from the
   *  same file apply. */
  inferenceIsOriginal: boolean;
  /** Upright size of the photo. */
  width: number | null;
  height: number | null;
  /** Removes any copies made. Safe to call more than once. */
  release: () => Promise<void>;
  /** Hands the matching copy to a later job: release() then leaves it, and the returned function
   *  removes it. Null when matching reads the original. */
  detachInferenceCopy: () => (() => void) | null;
}

export async function prepareWorkingImage(originalPath: string, format: PhotoFormat): Promise<WorkingImage> {
  const made: string[] = [];
  let decodePath = originalPath;
  let width: number | null = null;
  let height: number | null = null;
  try {
    if (format === "heic") {
      decodePath = await uploadTempPath(null, ".jpg");
      made.push(decodePath);
      ({ width, height } = await heicToJpegFile(originalPath, decodePath));
    } else {
      const meta = await sharp(originalPath, originalSharpOptions()).metadata();
      const turned = (meta.orientation ?? 1) >= 5;
      width = (turned ? meta.height : meta.width) ?? null;
      height = (turned ? meta.width : meta.height) ?? null;
    }

    let inferencePath = decodePath;
    const pixels = (width ?? 0) * (height ?? 0);
    if (pixels > INFERENCE_SOURCE_MAX_PIXELS) {
      const scale = Math.sqrt(INFERENCE_COPY_PIXELS / pixels);
      inferencePath = await uploadTempPath(null, ".jpg");
      made.push(inferencePath);
      await sharp(decodePath, originalSharpOptions())
        .rotate()
        .resize({ width: Math.max(1, Math.round(width! * scale)) })
        .jpeg({ quality: INFERENCE_COPY_QUALITY })
        .toFile(inferencePath);
    }

    let detached: string | null = null;
    return {
      decodePath,
      inferencePath,
      inferenceIsOriginal: inferencePath === originalPath,
      width,
      height,
      release: async () => {
        await Promise.all(made.filter((p) => p !== detached).map((p) => rm(p, { force: true })));
      },
      detachInferenceCopy: () => {
        if (inferencePath === originalPath) return null;
        detached = inferencePath;
        const copy = inferencePath;
        return () => void rm(copy, { force: true }).catch(() => {});
      },
    };
  } catch (err) {
    await Promise.all(made.map((p) => rm(p, { force: true })));
    throw err;
  }
}

/** A small JPEG of the photo for the import screen, as a data URL. */
export async function previewDataUrlFor(decodePath: string): Promise<string> {
  const jpeg = await sharp(decodePath, originalSharpOptions())
    .rotate()
    .resize({ width: PREVIEW_WIDTH, height: PREVIEW_WIDTH, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}
