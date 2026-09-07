// For every Wikimedia-sourced species reference photo, checks whether iNaturalist has its own
// usable default photo for that species (reusing the same robust taxon lookup — exact match,
// reclassification check, subspecies fallback — that lazyEnrich.ts's own enrichment already
// relies on) and, if so, switches the species' canonical reference photo over to it entirely:
// new reference_photo/credit/license, freshly generated non-destructive derivatives, and a
// focal point recomputed if the new photo is itself portrait-mismatched.
//
// This is the real fix for the ~2,654 Wikimedia-sourced species this app otherwise can't
// safely bulk re-fetch right now (Wikimedia's own media CDN has been returning sustained
// 600-second retry-after penalties on nearly every request today) — found by hand that a
// good number of these species (e.g. the Northern Goshawk) have their OWN separate,
// perfectly fine iNaturalist photo sitting unused, just because whichever enrichment pass ran
// first happened to land on Wikimedia instead. Runs at the normal iNaturalist concurrency
// (this never touches Wikimedia at all) — anything iNaturalist doesn't have a photo for is
// left alone, still Wikimedia-sourced, for a later slow/gentle pass once that penalty clears.
import { pool } from "../db.js";
import { fetchWithRetry, fetchINaturalistTaxon, fetchFirstTaxonPhoto } from "../species/lazyEnrich.js";
import { normalizeLicense } from "../species/licensePolicy.js";
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
  return { x: (sumX / sumWeight / (w - 1)) * 100, y: (sumY / sumWeight / (h - 1)) * 100 };
}

async function switchOne(row: {
  id: string;
  scientific_name: string;
  reference_display_path: string;
  reference_thumb_path: string;
}): Promise<"switched" | "no-inat-photo" | "fetch-failed"> {
  const taxon = await fetchINaturalistTaxon(row.scientific_name);
  if (!taxon) return "no-inat-photo";
  // default_photo is a curator flag, not "has a photo" — a taxon can have real taxon_photos
  // with none of them flagged as default (see lazyEnrich.ts's fetchFirstTaxonPhoto comment).
  // Falling back to the first real photo here is what closes most of the "no-inat-photo"
  // gap found while answering "is there a third source" — it isn't a new source, it's this
  // same iNaturalist taxon record's own photo pool, just not the one field this script
  // originally checked.
  const photo = taxon.defaultPhoto ?? (await fetchFirstTaxonPhoto(taxon.id));
  if (!photo) return "no-inat-photo";

  const res = await fetchWithRetry(photo.medium_url);
  if (!res.ok) return "fetch-failed";
  const buffer = Buffer.from(await res.arrayBuffer());

  const tmpPaths = await generateReferenceDerivatives(buffer, `_tmp-switch-${row.id}`);
  renameSync(tmpPaths.displayPath, row.reference_display_path);
  renameSync(tmpPaths.thumbPath, row.reference_thumb_path);

  let focalX: number | null = null;
  let focalY: number | null = null;
  const meta = await sharp(buffer).metadata();
  if (meta.width && meta.height && isMismatched(meta.width / meta.height)) {
    const focal = await computeFocalPoint(buffer);
    if (focal) {
      focalX = focal.x;
      focalY = focal.y;
    }
  }

  const license = photo.license_code ? normalizeLicense(photo.license_code) : "all-rights-reserved";
  await pool.query(
    `UPDATE species SET reference_photo = $1, reference_credit = $2, reference_license = $3,
       reference_focal_x = $4, reference_focal_y = $5 WHERE id = $6`,
    [photo.medium_url, photo.attribution, license, focalX, focalY, row.id],
  );
  return "switched";
}

async function main() {
  const speciesRes = await pool.query<{
    id: string;
    scientific_name: string;
    reference_display_path: string;
    reference_thumb_path: string;
  }>(
    `SELECT id, scientific_name, reference_display_path, reference_thumb_path FROM species
     WHERE reference_photo LIKE '%upload.wikimedia.org%' AND reference_display_path IS NOT NULL AND reference_thumb_path IS NOT NULL`,
  );
  console.log(`[switch-wm-to-inat] checking ${speciesRes.rows.length} Wikimedia-sourced species for an iNaturalist alternative`);

  const counts = { switched: 0, "no-inat-photo": 0, "fetch-failed": 0, error: 0 };
  let done = 0;
  await mapWithConcurrency(speciesRes.rows, CONCURRENCY, async (row) => {
    let outcome: "switched" | "no-inat-photo" | "fetch-failed" | "error";
    try {
      outcome = await switchOne(row);
    } catch (err) {
      console.error(`[switch-wm-to-inat] error on ${row.scientific_name}:`, err instanceof Error ? err.message : err);
      outcome = "error";
    }
    counts[outcome]++;
    done++;
    if (done % 250 === 0) {
      console.log(`[switch-wm-to-inat] ${done}/${speciesRes.rows.length} — switched:${counts.switched} no-photo:${counts["no-inat-photo"]} failed:${counts["fetch-failed"]} errors:${counts.error}`);
    }
  });

  console.log(`[switch-wm-to-inat] done. ${JSON.stringify(counts)}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
