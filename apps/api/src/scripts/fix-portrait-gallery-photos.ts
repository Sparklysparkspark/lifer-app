// Same fix as fix-portrait-reference-photos.ts, for the SECONDARY gallery photos
// (species_reference_photos — the extra photos you arrow through in the lightbox) instead of
// each species' primary reference photo. Every one of these was ALSO overwritten by the
// original destructive-crop bug (see uploads/image.ts's own comment), so unlike the primary-
// photo pass there's no cheap metadata-only pre-check to skip ahead of a download — a gallery
// photo has no "default photo" API endpoint the way a species/taxon does, so the only way to
// know its real aspect ratio is to actually fetch it. That's fine here: every iNaturalist-
// sourced gallery photo needs re-fetching regardless (to restore the full, non-destructive
// image), so checking its aspect ratio is just a side effect of a fetch that had to happen
// anyway, not extra cost on top.
//
// iNaturalist only — same as the primary-photo pass, deliberately skips every Wikimedia-
// sourced gallery photo rather than hitting Wikimedia's servers in bulk again.
import { pool } from "../db.js";
import { fetchWithRetry } from "../species/lazyEnrich.js";
import { generateReferenceDerivatives } from "../uploads/image.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";
import { renameSync } from "node:fs";
import sharp from "sharp";

const CONCURRENCY = 8;
const HERO_ASPECT = 16 / 9;
const THUMB_ASPECT = 1;
const MISMATCH_LOG_RATIO_THRESHOLD = 0.35;

function isMismatched(sourceAspect: number): boolean {
  const heroDelta = Math.abs(Math.log(sourceAspect / HERO_ASPECT));
  const thumbDelta = Math.abs(Math.log(sourceAspect / THUMB_ASPECT));
  return heroDelta > MISMATCH_LOG_RATIO_THRESHOLD && thumbDelta > MISMATCH_LOG_RATIO_THRESHOLD;
}

// Same standalone edge-energy-centroid saliency proxy as fix-portrait-reference-photos.ts —
// see that file's own comment for why this is computed independently rather than relying on
// sharp's own internal attention-strategy crop math.
async function computeFocalPoint(buffer: Buffer): Promise<{ x: number; y: number } | null> {
  const DOWNSAMPLE_WIDTH = 64;
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) return null;
  const dsHeight = Math.max(2, Math.round((DOWNSAMPLE_WIDTH * meta.height) / meta.width));

  const { data, info } = await sharp(buffer)
    .rotate()
    .greyscale()
    .resize({ width: DOWNSAMPLE_WIDTH, height: dsHeight, fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  let sumWeight = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = data[y * w + x + 1] - data[y * w + x - 1];
      const gy = data[(y + 1) * w + x] - data[(y - 1) * w + x];
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      const weight = magnitude * magnitude;
      sumWeight += weight;
      sumX += weight * x;
      sumY += weight * y;
    }
  }
  if (sumWeight === 0) return null;
  return {
    x: (sumX / sumWeight / (w - 1)) * 100,
    y: (sumY / sumWeight / (h - 1)) * 100,
  };
}

async function fixOne(row: {
  id: string;
  photo_url: string;
  display_path: string;
  thumb_path: string;
}): Promise<"restored" | "fetch-failed"> {
  const res = await fetchWithRetry(row.photo_url);
  if (!res.ok) return "fetch-failed";
  const buffer = Buffer.from(await res.arrayBuffer());

  const tmpPaths = await generateReferenceDerivatives(buffer, `_tmp-gallery-${row.id}`);
  renameSync(tmpPaths.displayPath, row.display_path);
  renameSync(tmpPaths.thumbPath, row.thumb_path);

  const meta = await sharp(buffer).metadata();
  if (meta.width && meta.height && isMismatched(meta.width / meta.height)) {
    const focal = await computeFocalPoint(buffer);
    if (focal) {
      await pool.query(
        `UPDATE species_reference_photos SET focal_x = $1, focal_y = $2 WHERE id = $3`,
        [focal.x, focal.y, row.id],
      );
    }
  }
  return "restored";
}

async function main() {
  const res = await pool.query<{ id: string; photo_url: string; display_path: string; thumb_path: string }>(
    `SELECT id, photo_url, display_path, thumb_path FROM species_reference_photos
     WHERE photo_url LIKE '%inaturalist%' AND display_path IS NOT NULL AND thumb_path IS NOT NULL`,
  );
  console.log(`[fix-gallery] restoring ${res.rows.length} iNaturalist-sourced gallery photos`);

  const counts = { restored: 0, "fetch-failed": 0, error: 0 };
  let done = 0;
  await mapWithConcurrency(res.rows, CONCURRENCY, async (row) => {
    let outcome: "restored" | "fetch-failed" | "error";
    try {
      outcome = await fixOne(row);
    } catch (err) {
      console.error(`[fix-gallery] error on gallery photo ${row.id}:`, err instanceof Error ? err.message : err);
      outcome = "error";
    }
    counts[outcome]++;
    done++;
    if (done % 1000 === 0) {
      console.log(`[fix-gallery] ${done}/${res.rows.length} — restored:${counts.restored} failed:${counts["fetch-failed"]} errors:${counts.error}`);
    }
  });

  console.log(`[fix-gallery] done. ${JSON.stringify(counts)}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
