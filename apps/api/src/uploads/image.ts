// Derivative generation via sharp/libvips (lifer-spec.md §4, §6). The app always renders
// from display_path per §6 rule 1 — the original upload buffer is discarded after this runs,
// per the storage model in §8 ("host display copies, not originals").
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

  await image
    .clone()
    .resize({ width: DISPLAY_WIDTH, withoutEnlargement: true })
    .webp({ quality: 85 })
    .toFile(displayPath);

  await image
    .clone()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(thumbPath);

  return { displayPath, thumbPath };
}

// Same shape as generateDerivatives above, just under APP_DATA_DIR instead of DATA_DIR (this
// is a shared species-reference cache, not part of any one photo library — see that
// constant's own comment) and a smaller target size — reference photos are sourced from
// external URLs (iNaturalist/Wikimedia Commons, see lazyEnrich.ts), keyed by their own id (a
// species id for the primary photo, a species_reference_photos row id for a gallery photo)
// rather than a photos.id.
//
// Width-only resize, full aspect preserved — deliberately NOT baking a crop into the stored
// file (a previous version of this function did, cropping to each display shape — 16:9 hero,
// square card — with sharp's attention-region heuristic). That was destructive: once a crop
// is baked into the only copy on disk, recovering the parts it cut off means re-fetching the
// original from its source all over again, and the heuristic itself wasn't reliable enough
// to be trusted running once, unsupervised, over the whole catalog (it can fixate on a bright
// twig or a textured background patch instead of the actual subject). The correct model —
// confirmed against how CardCropEditor.tsx already handles a USER's own cover photo — is to
// always keep the full source image on disk and store the crop as data (a focal point)
// applied at render time, never re-encoded away. species.reference_focal_x/y (migration 043)
// is that stored focal point — computed automatically (see scripts/fix-portrait-reference-
// photos.ts), never something a user needs to set by hand.
export async function generateReferenceDerivatives(buffer: Buffer, key: string): Promise<DerivativePaths> {
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
