// One-off: runs the same gallery-backfill fetchAnyGallery() attempt species/routes.ts now
// gates on gallery_backfilled_at, for a specific species id passed as argv[2] — used to
// resolve the Green-Winged Teal (Anas carolinensis) "loads forever" report without making a
// live user request sit through the slow Commons fallback themselves.
import { pool } from "../db.js";
import { fetchAnyGallery, persistGalleryPromotingMainIfMissing } from "../species/lazyEnrich.js";

async function main() {
  const speciesId = process.argv[2];
  if (!speciesId) {
    console.error("usage: backfill-one-gallery.ts <species-id>");
    process.exit(1);
  }

  const res = await pool.query(`SELECT * FROM species WHERE id = $1`, [speciesId]);
  const species = res.rows[0];
  if (!species) {
    console.error("species not found");
    process.exit(1);
  }

  console.log(`Fetching gallery for ${species.common_name} (${species.scientific_name})...`);
  const gallery = await fetchAnyGallery(species);
  console.log(`Found ${gallery.length} gallery photos.`);
  await persistGalleryPromotingMainIfMissing(speciesId, gallery, !!species.reference_photo);
  await pool.query(`UPDATE species SET gallery_backfilled_at = now() WHERE id = $1`, [speciesId]);
  console.log("Marked gallery_backfilled_at.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
