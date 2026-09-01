// One-off backfill for photos.width/height (migration 062) — every photo uploaded before this
// column existed has display_path/thumb_path already on disk, so this just reads the existing
// display file's real pixel dimensions with sharp rather than needing the original buffer
// again. Going forward, generateDerivatives (uploads/image.ts) sets these at insert time for
// every new capture, reimport, and trip import — this script only needs to run once per
// install to fill in the gap for anything uploaded before that.
import sharp from "sharp";
import { pool } from "../db.js";

async function main() {
  const res = await pool.query<{ id: string; display_path: string | null }>(
    `SELECT id, display_path FROM photos WHERE width IS NULL AND display_path IS NOT NULL`,
  );
  console.log(`[backfill-photo-dimensions] ${res.rows.length} photos to fix`);

  let fixed = 0;
  let failed = 0;
  for (const photo of res.rows) {
    try {
      const { width, height } = await sharp(photo.display_path!).metadata();
      if (!width || !height) {
        failed++;
        continue;
      }
      await pool.query(`UPDATE photos SET width = $1, height = $2 WHERE id = $3`, [width, height, photo.id]);
      fixed++;
    } catch {
      // Missing/corrupt display file on disk (e.g. a disconnected external drive at backfill
      // time) — leaves width/height NULL, same as before this script ran. MasonryGrid already
      // falls back to a neutral aspect ratio for any item with no known dimensions.
      failed++;
    }
  }

  console.log(`[backfill-photo-dimensions] done. ${fixed} fixed, ${failed} failed/skipped.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
