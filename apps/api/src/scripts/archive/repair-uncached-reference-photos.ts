// One-off repair pass: a small long tail of reference/gallery photos never got a local
// display/thumb derivative cached (downloadAndCacheImage in lazyEnrich.ts is deliberately
// best-effort — a network blip or a since-dead URL just leaves that one photo hotlinked
// rather than failing the whole enrichment). Those species currently fall back to serving
// iNaturalist's own URL directly (see species/routes.ts's referencePhotoUrl fallback) — this
// re-attempts the download for every such row so the catalog ends up fully local, not just
// "almost all of it." Safe to re-run: only ever touches rows still missing a derivative.
import { pool } from "../db.js";
import { downloadAndCacheImage } from "../species/lazyEnrich.js";

async function repairMainPhotos(): Promise<{ fixed: number; stillFailing: string[] }> {
  const res = await pool.query<{ id: string; scientific_name: string; reference_photo: string }>(
    `SELECT id, scientific_name, reference_photo FROM species
     WHERE reference_photo IS NOT NULL AND reference_display_path IS NULL`,
  );
  let fixed = 0;
  const stillFailing: string[] = [];
  for (const row of res.rows) {
    const cached = await downloadAndCacheImage(row.reference_photo, row.id);
    if (cached) {
      await pool.query(`UPDATE species SET reference_display_path = $1, reference_thumb_path = $2 WHERE id = $3`, [
        cached.displayPath,
        cached.thumbPath,
        row.id,
      ]);
      fixed++;
    } else {
      stillFailing.push(row.scientific_name);
    }
  }
  return { fixed, stillFailing };
}

async function repairGalleryPhotos(): Promise<{ fixed: number; stillFailing: number }> {
  const res = await pool.query<{ id: string; photo_url: string }>(
    `SELECT id, photo_url FROM species_reference_photos WHERE display_path IS NULL`,
  );
  let fixed = 0;
  let stillFailing = 0;
  for (const row of res.rows) {
    const cached = await downloadAndCacheImage(row.photo_url, `gallery-${row.id}`);
    if (cached) {
      await pool.query(`UPDATE species_reference_photos SET display_path = $1, thumb_path = $2 WHERE id = $3`, [
        cached.displayPath,
        cached.thumbPath,
        row.id,
      ]);
      fixed++;
    } else {
      stillFailing++;
    }
  }
  return { fixed, stillFailing };
}

async function main() {
  console.log("[repair-photos] checking main reference photos...");
  const main = await repairMainPhotos();
  console.log(`[repair-photos] main: ${main.fixed} fixed, ${main.stillFailing.length} still failing`);
  if (main.stillFailing.length > 0) {
    console.log("[repair-photos] still failing (main):", main.stillFailing.join(", "));
  }

  console.log("[repair-photos] checking gallery photos...");
  const gallery = await repairGalleryPhotos();
  console.log(`[repair-photos] gallery: ${gallery.fixed} fixed, ${gallery.stillFailing} still failing`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
