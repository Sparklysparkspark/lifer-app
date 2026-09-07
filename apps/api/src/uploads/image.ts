// Derivative generation via sharp/libvips. The app always renders from display_path — the
// original upload buffer is discarded after this runs; only the display/thumb copies are kept.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { APP_DATA_DIR } from "../config.js";

const DISPLAY_WIDTH = 2560;
const THUMB_WIDTH = 400;
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
  mkdirSync(displayDir, { recursive: true });
  mkdirSync(thumbDir, { recursive: true });

  const displayPath = path.join(displayDir, `${photoId}.webp`);
  const thumbPath = path.join(thumbDir, `${photoId}.webp`);

  const image = sharp(buffer).rotate(); // auto-orient from EXIF before resizing

  // sharp's plain metadata() reports the SOURCE file's raw width/height, not swapped for EXIF
  // orientation — toFile()'s own returned info, by contrast, reflects the real output pixels
  // after the rotate+resize pipeline actually ran, so its aspect ratio is the correct one to
  // size a masonry tile with (the resize preserves aspect ratio; withoutEnlargement only ever
  // shrinks, never distorts it).
  const displayInfo = await image
    .clone()
    .resize({ width: DISPLAY_WIDTH, withoutEnlargement: true })
    .webp({ quality: 85 })
    .toFile(displayPath);

  await image
    .clone()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(thumbPath);

  return { displayPath, thumbPath, width: displayInfo.width ?? null, height: displayInfo.height ?? null };
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
  mkdirSync(displayDir, { recursive: true });
  mkdirSync(thumbDir, { recursive: true });

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
