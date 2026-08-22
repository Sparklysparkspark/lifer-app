// One-off backfill for species with an empty main reference photo despite having real cached
// gallery photos. iNaturalist's taxon record doesn't always have a "default_photo" flagged
// even when its photo pool has real entries (e.g. Common Minke Whale had 6 gallery photos but
// no main photo). enrichSpecies now handles this going forward by borrowing the first gallery
// photo as the main one, but species already enriched before that fix are stuck since the
// main enrich-all-species.ts pass only revisits enriched_at IS NULL rows. Promotes each
// affected species' first (lowest sort_order) gallery photo to be its main photo, removing
// that row from the gallery so it isn't shown twice.
import { pool } from "../db.js";

async function main() {
  const res = await pool.query<{ id: string; scientific_name: string }>(
    `SELECT s.id, s.scientific_name FROM species s WHERE s.reference_photo IS NULL
     AND EXISTS (SELECT 1 FROM species_reference_photos p WHERE p.species_id = s.id)`,
  );
  console.log(`[backfill-main-photo] ${res.rows.length} species to fix`);

  let fixed = 0;
  for (const species of res.rows) {
    const photoRes = await pool.query<{
      id: string;
      photo_url: string;
      credit: string;
      license: string;
      display_path: string | null;
      thumb_path: string | null;
    }>(
      `SELECT id, photo_url, credit, license, display_path, thumb_path FROM species_reference_photos
       WHERE species_id = $1 ORDER BY sort_order ASC LIMIT 1`,
      [species.id],
    );
    const photo = photoRes.rows[0];
    if (!photo) continue;

    await pool.query(
      `UPDATE species SET reference_photo = $1, reference_credit = $2, reference_license = $3,
         reference_display_path = $4, reference_thumb_path = $5 WHERE id = $6`,
      [photo.photo_url, photo.credit, photo.license, photo.display_path, photo.thumb_path, species.id],
    );
    await pool.query(`DELETE FROM species_reference_photos WHERE id = $1`, [photo.id]);
    fixed++;
  }

  console.log(`[backfill-main-photo] done. ${fixed} species fixed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
