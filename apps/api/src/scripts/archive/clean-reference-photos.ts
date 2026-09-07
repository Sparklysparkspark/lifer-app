// Retroactively applies lazyEnrich.ts's EXCLUDE_PATTERNS to every already-downloaded
// reference photo — both the gallery (species_reference_photos) AND the MAIN photo
// (species.reference_photo), which an earlier version of this script never checked at all.
// That gap is exactly how Barrow's Goldeneye kept a museum specimen photo
// ("Bucephala_islandica_MWNH_1021.JPG") as its main reference photo — MWNH is a natural
// history museum acronym with no descriptive word in the filename at all, so this also adds a
// list of known museum/collection acronyms alongside the original keyword patterns. Only
// affects Wikimedia Commons URLs (the one source with a human-readable filename) — iNaturalist
// URLs are opaque IDs and were never filtered by filename in the first place. When a bad main
// photo is removed, the first clean gallery photo (if any) is promoted to take its place
// instead of leaving the species photo-less.
import { unlink } from "node:fs/promises";
import { pool } from "../db.js";

const EXCLUDE_PATTERNS =
  /map|iucn|status|logo|icon|diagram|locator|plate|sound|chart|specimen|museum|skull|skeleton|taxidermy|\bmount(ed)?\b|herbarium|illustration|drawing|painting|sketch|clipart|clip[- ]art|silhouette|stamp|postage|coin|banknote|nest\b|egg[s]?\b|footprint|track[s]?\b|scat\b|dropping|pellet|feather\b|wing[- ]?(only|detail)|comparison|anatomy|x[- ]?ray|radiograph|cartoon|line[- ]art|coat[- ]of[- ]arms|flag\b|MWNH|ZMA\.|RMNH|NHMUK|MNHN|USNM|AMNH|FMNH|ZMUC|BMNH|NRM[_ ]|SMF[_ ]|NHMW|MHNG|ANSP|MCZ[_ ]|MVZ[_ ]|CAS[_ ]|YPM[_ ]|MHNT|(?<![a-z0-9])dist(ribution)?(?![a-z0-9])|area\.(png|jpe?g)|(?<![a-z0-9])range(?![a-z0-9])/i;

async function main() {
  const dryRun = !process.argv.includes("--apply");

  // --- Gallery photos ---
  const galleryRes = await pool.query<{
    id: string;
    photo_url: string;
    common_name: string | null;
    display_path: string | null;
    thumb_path: string | null;
  }>(
    `SELECT srp.id, srp.photo_url, s.common_name, srp.display_path, srp.thumb_path
     FROM species_reference_photos srp
     JOIN species s ON s.id = srp.species_id
     WHERE srp.photo_url ILIKE '%wikimedia%'`,
  );
  const galleryToDelete = galleryRes.rows.filter((r) => EXCLUDE_PATTERNS.test(r.photo_url));

  // --- Main reference photos ---
  const mainRes = await pool.query<{
    id: string;
    common_name: string | null;
    reference_photo: string;
    reference_display_path: string | null;
    reference_thumb_path: string | null;
  }>(
    `SELECT id, common_name, reference_photo, reference_display_path, reference_thumb_path
     FROM species
     WHERE reference_photo ILIKE '%wikimedia%'`,
  );
  const mainToFix = mainRes.rows.filter((r) => EXCLUDE_PATTERNS.test(r.reference_photo));

  console.log(`Checked ${galleryRes.rows.length} gallery photos — ${galleryToDelete.length} match exclude patterns.`);
  console.log(`Checked ${mainRes.rows.length} main reference photos — ${mainToFix.length} match exclude patterns.\n`);
  for (const row of galleryToDelete) console.log(`  [gallery] [${row.common_name}] ${row.photo_url}`);
  for (const row of mainToFix) console.log(`  [MAIN]    [${row.common_name}] ${row.reference_photo}`);

  if (dryRun) {
    console.log("\nDry run — pass --apply to actually fix these.");
    return;
  }

  for (const row of galleryToDelete) {
    for (const localPath of [row.display_path, row.thumb_path]) {
      if (!localPath) continue;
      await unlink(localPath).catch(() => {});
    }
  }
  const galleryIds = galleryToDelete.map((r) => r.id);
  if (galleryIds.length > 0) {
    await pool.query(`DELETE FROM species_reference_photos WHERE id = ANY($1)`, [galleryIds]);
  }

  let promoted = 0;
  let blanked = 0;
  for (const row of mainToFix) {
    for (const localPath of [row.reference_display_path, row.reference_thumb_path]) {
      if (!localPath) continue;
      await unlink(localPath).catch(() => {});
    }

    // Promote the first remaining gallery photo (if any, and not itself just deleted above)
    // that isn't also flagged as bad — a species shouldn't go from "one bad main photo" to
    // "no photo at all" when it already has a perfectly good gallery photo sitting right there.
    const replacement = await pool.query<{
      id: string;
      photo_url: string;
      credit: string;
      license: string;
      display_path: string | null;
      thumb_path: string | null;
    }>(
      `SELECT id, photo_url, credit, license, display_path, thumb_path
       FROM species_reference_photos WHERE species_id = $1 ORDER BY sort_order LIMIT 5`,
      [row.id],
    );
    const clean = replacement.rows.find((p) => !EXCLUDE_PATTERNS.test(p.photo_url));

    if (clean) {
      await pool.query(
        `UPDATE species SET reference_photo = $1, reference_credit = $2, reference_license = $3,
           reference_display_path = $4, reference_thumb_path = $5 WHERE id = $6`,
        [clean.photo_url, clean.credit, clean.license, clean.display_path, clean.thumb_path, row.id],
      );
      await pool.query(`DELETE FROM species_reference_photos WHERE id = $1`, [clean.id]);
      promoted++;
    } else {
      await pool.query(
        `UPDATE species SET reference_photo = NULL, reference_credit = NULL, reference_license = NULL,
           reference_display_path = NULL, reference_thumb_path = NULL WHERE id = $1`,
        [row.id],
      );
      blanked++;
    }
  }

  console.log(
    `\nDeleted ${galleryIds.length} gallery rows. Fixed ${mainToFix.length} main photos ` +
      `(${promoted} promoted from gallery, ${blanked} left blank — no clean replacement available).`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
