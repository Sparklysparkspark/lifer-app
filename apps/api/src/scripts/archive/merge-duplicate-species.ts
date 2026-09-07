// Merges the "stale genus name" species row into the "current" one, for the 38 cleanly-
// resolved pairs found by find-duplicate-species.ts (written to
// /tmp/duplicate-species-resolved.json). Confirmed via query before running this: zero
// captures and zero user_species rows reference any of these species, so there is no personal
// capture/collection data to migrate — only region_species, sea_zone_species, and
// species_reference_photos might have rows worth keeping from the stale side.
import { readFileSync } from "node:fs";
import { pool } from "../db.js";

interface MergePair {
  keepId: string;
  mergeIds: string[];
}

async function mergeOne(keepId: string, staleId: string, dryRun: boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // region_species / sea_zone_species: move any stale-side row the keep side doesn't
    // already have (avoid unique-constraint conflicts on (region_id, species_id)).
    const regionMoved = await client.query(
      `INSERT INTO region_species (region_id, species_id, local_frequency, local_tier, is_vagrant, seasonality)
       SELECT region_id, $1, local_frequency, local_tier, is_vagrant, seasonality
       FROM region_species WHERE species_id = $2
       ON CONFLICT (region_id, species_id) DO NOTHING
       RETURNING region_id`,
      [keepId, staleId],
    );
    const seaZoneMoved = await client.query(
      `INSERT INTO sea_zone_species (sea_zone_id, species_id)
       SELECT sea_zone_id, $1 FROM sea_zone_species WHERE species_id = $2
       ON CONFLICT (sea_zone_id, species_id) DO NOTHING
       RETURNING sea_zone_id`,
      [keepId, staleId],
    );
    const photosMoved = await client.query(
      `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, sort_order, display_path, thumb_path)
       SELECT $1, photo_url, credit, license, sort_order, display_path, thumb_path
       FROM species_reference_photos WHERE species_id = $2
       ON CONFLICT (species_id, photo_url) DO NOTHING
       RETURNING id`,
      [keepId, staleId],
    );

    // Sanity check repeated right before delete, inside the transaction — the earlier
    // read-only check covered all 38 pairs at once; this re-check is cheap insurance against
    // any capture/user_species row created between that check and this run.
    const captureCheck = await client.query(`SELECT count(*) FROM captures WHERE species_id = $1`, [staleId]);
    const userSpeciesCheck = await client.query(`SELECT count(*) FROM user_species WHERE species_id = $1`, [staleId]);
    if (Number(captureCheck.rows[0].count) > 0 || Number(userSpeciesCheck.rows[0].count) > 0) {
      throw new Error(`species ${staleId} has captures/user_species rows — aborting this pair, needs manual handling`);
    }

    if (dryRun) {
      console.log(
        `  [dry run] would merge ${staleId} -> ${keepId} (moved ${regionMoved.rowCount} region_species, ` +
          `${seaZoneMoved.rowCount} sea_zone_species, ${photosMoved.rowCount} reference photos)`,
      );
      await client.query("ROLLBACK");
      return;
    }

    // species_traits/species_rarity/originals/capture_species cascade-delete automatically
    // (see migration FK delete_rule check) — captures/user_species would block the delete
    // with NO ACTION, which is exactly why they're checked above first.
    await client.query(`DELETE FROM species WHERE id = $1`, [staleId]);
    await client.query("COMMIT");
    console.log(
      `  merged ${staleId} -> ${keepId} (moved ${regionMoved.rowCount} region_species, ` +
        `${seaZoneMoved.rowCount} sea_zone_species, ${photosMoved.rowCount} reference photos)`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  const pairs: MergePair[] = JSON.parse(readFileSync("/tmp/duplicate-species-resolved.json", "utf-8"));

  console.log(`${pairs.length} groups to merge${dryRun ? " (dry run — pass --apply to commit)" : ""}\n`);

  let merged = 0;
  let failed = 0;
  for (const pair of pairs) {
    for (const staleId of pair.mergeIds) {
      try {
        await mergeOne(pair.keepId, staleId, dryRun);
        merged++;
      } catch (err) {
        failed++;
        console.error(`  FAILED merging ${staleId} -> ${pair.keepId}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  console.log(`\n${dryRun ? "Would merge" : "Merged"} ${merged} species rows, ${failed} failed.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
