// One-off backfill for species/gallery rows that already have a reference_photo/photo_url
// (enriched before local caching existed) but no local display_path yet. Downloads and caches
// directly from the URL already on file — no need to redo the iNaturalist/Wikipedia lookups
// enrichSpecies does, just the image fetch+resize.
import { pool } from "../db.js";
import { downloadAndCacheImage as cache } from "../species/lazyEnrich.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 4;

async function main() {
  const speciesRes = await pool.query<{ id: string; reference_photo: string }>(
    `SELECT id, reference_photo FROM species WHERE reference_photo IS NOT NULL AND reference_display_path IS NULL`,
  );
  console.log(`[backfill-reference] ${speciesRes.rows.length} species main photos to cache`);
  let done = 0;
  await mapWithConcurrency(speciesRes.rows, CONCURRENCY, async (row) => {
    const paths = await cache(row.reference_photo, row.id);
    if (paths) {
      await pool.query(`UPDATE species SET reference_display_path = $1, reference_thumb_path = $2 WHERE id = $3`, [
        paths.displayPath,
        paths.thumbPath,
        row.id,
      ]);
    }
    done++;
    if (done % 100 === 0) console.log(`[backfill-reference] species: ${done}/${speciesRes.rows.length}`);
  });

  const galleryRes = await pool.query<{ id: string; photo_url: string }>(
    `SELECT id, photo_url FROM species_reference_photos WHERE display_path IS NULL`,
  );
  console.log(`[backfill-reference] ${galleryRes.rows.length} gallery photos to cache`);
  let doneGallery = 0;
  await mapWithConcurrency(galleryRes.rows, CONCURRENCY, async (row) => {
    const paths = await cache(row.photo_url, `gallery-${row.id}`);
    if (paths) {
      await pool.query(`UPDATE species_reference_photos SET display_path = $1, thumb_path = $2 WHERE id = $3`, [
        paths.displayPath,
        paths.thumbPath,
        row.id,
      ]);
    }
    doneGallery++;
    if (doneGallery % 100 === 0) console.log(`[backfill-reference] gallery: ${doneGallery}/${galleryRes.rows.length}`);
  });

  console.log(`[backfill-reference] done.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
