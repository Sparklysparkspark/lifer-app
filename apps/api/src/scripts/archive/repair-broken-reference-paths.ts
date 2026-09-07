// Repairs species_reference_photos / species.reference_display_path / species.reference_thumb_path
// rows whose local file paths were baked in from a different machine's APP_DATA_DIR (the
// desktop app's catalog seed is a pg_dump of the dev database, and dev-machine paths leak
// straight through — see the "gallery photos broken" investigation).
//
// Species/gallery-photo ids are stable across every install descended from the same catalog
// seed, and the actual cached image files (named by id, e.g. reference-display/{id}.webp)
// still exist on the machine that originally ran enrichment — so this is a pure local file
// copy + path rewrite, no re-fetching from iNaturalist needed. Only a row whose file is
// missing on BOTH ends falls back to clearing the path (and, if a species ends up with no
// working photo anywhere, resetting enriched_at so lazyEnrich/pack-apply can fill it back in
// properly later).
//
// Usage (source = this machine's own dev-mode cache dirs by default; target = the desktop
// app's live embedded Postgres + its real APP_DATA_DIR):
//   DATABASE_URL="postgres://postgres:lifer-embedded@localhost:<port>/lifer" \
//   TARGET_APP_DATA_DIR="/Users/you/Library/Application Support/app.lifer.desktop/app-data" \
//   npx tsx apps/api/src/scripts/repair-broken-reference-paths.ts --apply
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { pool } from "../db.js";

const SOURCE_DISPLAY_DIR = path.join(DATA_DIR, "reference-display");
const SOURCE_THUMB_DIR = path.join(DATA_DIR, "reference-thumb");
const TARGET_APP_DATA_DIR = process.env.TARGET_APP_DATA_DIR;
if (!TARGET_APP_DATA_DIR) {
  console.error("Set TARGET_APP_DATA_DIR to the target install's real APP_DATA_DIR (e.g. the desktop app's app-data folder).");
  process.exit(1);
}
const TARGET_DISPLAY_DIR = path.join(TARGET_APP_DATA_DIR, "reference-display");
const TARGET_THUMB_DIR = path.join(TARGET_APP_DATA_DIR, "reference-thumb");

/** Given a broken path, try to recover it by copying the same-named file from this machine's
 *  own dev cache into the target's real APP_DATA_DIR. Returns the new, working path, or null
 *  if no source file exists either (genuinely gone, not just a wrong-machine path). */
async function recover(brokenPath: string, sourceDir: string, targetDir: string): Promise<string | null> {
  const filename = path.basename(brokenPath);
  const sourcePath = path.join(sourceDir, filename);
  const targetPath = path.join(targetDir, filename);
  if (existsSync(targetPath)) return targetPath;
  if (!existsSync(sourcePath)) return null;
  await mkdir(targetDir, { recursive: true });
  await copyFile(sourcePath, targetPath);
  return targetPath;
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  let galleryRecovered = 0;
  let galleryCleared = 0;
  let mainRecovered = 0;
  let mainCleared = 0;

  // --- Gallery photos ---
  const galleryRes = await pool.query<{
    id: string;
    display_path: string | null;
    thumb_path: string | null;
  }>(`SELECT id, display_path, thumb_path FROM species_reference_photos`);
  const galleryBroken = galleryRes.rows.filter(
    (r) => (r.display_path && !existsSync(r.display_path)) || (r.thumb_path && !existsSync(r.thumb_path)),
  );

  // --- Main reference photos ---
  const mainRes = await pool.query<{
    id: string;
    reference_display_path: string | null;
    reference_thumb_path: string | null;
  }>(`SELECT id, reference_display_path, reference_thumb_path FROM species WHERE reference_photo IS NOT NULL`);
  const mainBroken = mainRes.rows.filter(
    (r) =>
      (r.reference_display_path && !existsSync(r.reference_display_path)) ||
      (r.reference_thumb_path && !existsSync(r.reference_thumb_path)),
  );

  console.log(`Checked ${galleryRes.rows.length} gallery photo rows — ${galleryBroken.length} have a broken path.`);
  console.log(`Checked ${mainRes.rows.length} species with a main photo — ${mainBroken.length} have a broken path.`);

  if (dryRun) {
    console.log("\nDry run — pass --apply to actually fix these.");
    return;
  }

  for (const row of galleryBroken) {
    const newDisplay = row.display_path
      ? existsSync(row.display_path)
        ? row.display_path
        : await recover(row.display_path, SOURCE_DISPLAY_DIR, TARGET_DISPLAY_DIR)
      : null;
    const newThumb = row.thumb_path
      ? existsSync(row.thumb_path)
        ? row.thumb_path
        : await recover(row.thumb_path, SOURCE_THUMB_DIR, TARGET_THUMB_DIR)
      : null;
    await pool.query(`UPDATE species_reference_photos SET display_path = $1, thumb_path = $2 WHERE id = $3`, [
      newDisplay,
      newThumb,
      row.id,
    ]);
    if (newDisplay || newThumb) galleryRecovered++;
    else galleryCleared++;
  }

  for (const row of mainBroken) {
    const newDisplay = row.reference_display_path
      ? existsSync(row.reference_display_path)
        ? row.reference_display_path
        : await recover(row.reference_display_path, SOURCE_DISPLAY_DIR, TARGET_DISPLAY_DIR)
      : null;
    const newThumb = row.reference_thumb_path
      ? existsSync(row.reference_thumb_path)
        ? row.reference_thumb_path
        : await recover(row.reference_thumb_path, SOURCE_THUMB_DIR, TARGET_THUMB_DIR)
      : null;
    await pool.query(`UPDATE species SET reference_display_path = $1, reference_thumb_path = $2 WHERE id = $3`, [
      newDisplay,
      newThumb,
      row.id,
    ]);
    if (newDisplay || newThumb) mainRecovered++;
    else mainCleared++;
  }

  // Only species with NOTHING working left (no main photo, no gallery photo) need
  // enriched_at reset — everything else already has at least one photo that actually loads.
  const speciesFullyBrokenRes = await pool.query<{ id: string }>(
    `SELECT s.id FROM species s
     WHERE s.enriched_at IS NOT NULL
       AND (s.reference_photo IS NULL OR s.reference_display_path IS NULL)
       AND NOT EXISTS (
         SELECT 1 FROM species_reference_photos srp
         WHERE srp.species_id = s.id AND srp.display_path IS NOT NULL
       )`,
  );
  const resetIds = speciesFullyBrokenRes.rows.map((r) => r.id);
  if (resetIds.length > 0) {
    await pool.query(`UPDATE species SET enriched_at = NULL WHERE id = ANY($1)`, [resetIds]);
  }

  console.log(
    `\nGallery: recovered ${galleryRecovered} from local cache, cleared ${galleryCleared} (no cached copy found).\n` +
      `Main photo: recovered ${mainRecovered} from local cache, cleared ${mainCleared} (no cached copy found).\n` +
      `Reset enriched_at on ${resetIds.length} species with nothing recoverable at all ` +
      `(they'll re-fetch fresh photos next time their page is viewed, if live calls are allowed for them).`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
