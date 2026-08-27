// Full restore for every iNaturalist-sourced species reference photo — the earlier destructive
// crop-baking bug (see uploads/image.ts's own comment) overwrote the ORIGINAL cached copies,
// so this unconditionally re-fetches every one from source rather than only the ones a cheap
// pre-check flags as visibly mismatched: a species whose crop wasn't visually consequential
// still isn't holding its true original file, and re-fetching is the only way to actually
// undo that rather than leave it as "good enough." A focal point is only computed/stored (see
// migration 043) for genuinely portrait-mismatched photos — everything else defaults to
// center, same as before.
import { pool } from "../db.js";
import { fetchWithRetry } from "../species/lazyEnrich.js";
import { generateReferenceDerivatives } from "../uploads/image.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";
import { renameSync } from "node:fs";
import sharp from "sharp";

const CONCURRENCY = 8;
const MISMATCH_LOG_RATIO_THRESHOLD = 0.35;
const HERO_ASPECT = 16 / 9;
const THUMB_ASPECT = 1;

function isMismatched(sourceAspect: number): boolean {
  const heroDelta = Math.abs(Math.log(sourceAspect / HERO_ASPECT));
  const thumbDelta = Math.abs(Math.log(sourceAspect / THUMB_ASPECT));
  return heroDelta > MISMATCH_LOG_RATIO_THRESHOLD && thumbDelta > MISMATCH_LOG_RATIO_THRESHOLD;
}

// A standalone, self-contained saliency proxy — NOT relying on sharp's own internal
// attention-strategy crop math (which only ever hands back a cropped image, never the
// coordinates it chose) so this can report an actual x/y focal point to store, not just bake
// a crop into a file. Downsamples to greyscale, computes a Sobel-style gradient magnitude at
// every pixel, and takes the weighted centroid of that magnitude (squared, to emphasize real
// edges over faint texture) — same rough idea as sharp's "entropy"/"attention" strategies
// (detail/contrast marks the subject), independently computed so the actual coordinates are
// available.
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
  reference_photo: string;
  reference_display_path: string;
  reference_thumb_path: string;
}): Promise<"restored" | "fetch-failed"> {
  const res = await fetchWithRetry(row.reference_photo);
  if (!res.ok) return "fetch-failed";
  const buffer = Buffer.from(await res.arrayBuffer());

  // Overwrite in place at this row's OWN already-stored paths (not a path reconstructed from
  // an id/key) — see generateReferenceDerivatives's sibling comment on why that matters.
  const tmpPaths = await generateReferenceDerivatives(buffer, `_tmp-${row.id}`);
  renameSync(tmpPaths.displayPath, row.reference_display_path);
  renameSync(tmpPaths.thumbPath, row.reference_thumb_path);

  const meta = await sharp(buffer).metadata();
  if (meta.width && meta.height && isMismatched(meta.width / meta.height)) {
    const focal = await computeFocalPoint(buffer);
    if (focal) {
      await pool.query(`UPDATE species SET reference_focal_x = $1, reference_focal_y = $2 WHERE id = $3`, [
        focal.x,
        focal.y,
        row.id,
      ]);
    }
  }
  return "restored";
}

async function main() {
  const speciesRes = await pool.query<{
    id: string;
    scientific_name: string;
    reference_photo: string;
    reference_display_path: string;
    reference_thumb_path: string;
  }>(
    `SELECT id, scientific_name, reference_photo, reference_display_path, reference_thumb_path FROM species
     WHERE reference_photo LIKE '%inaturalist%' AND reference_display_path IS NOT NULL AND reference_thumb_path IS NOT NULL`,
  );
  console.log(`[fix-portrait] restoring ${speciesRes.rows.length} iNaturalist-sourced species (full re-fetch, no pre-check)`);

  const counts = { restored: 0, "fetch-failed": 0, error: 0 };
  let done = 0;
  await mapWithConcurrency(speciesRes.rows, CONCURRENCY, async (row) => {
    let outcome: "restored" | "fetch-failed" | "error";
    try {
      outcome = await fixOne(row);
    } catch (err) {
      console.error(`[fix-portrait] error on ${row.scientific_name}:`, err instanceof Error ? err.message : err);
      outcome = "error";
    }
    counts[outcome]++;
    done++;
    if (done % 500 === 0) {
      console.log(`[fix-portrait] ${done}/${speciesRes.rows.length} — restored:${counts.restored} failed:${counts["fetch-failed"]} errors:${counts.error}`);
    }
  });

  console.log(`[fix-portrait] done. ${JSON.stringify(counts)}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
