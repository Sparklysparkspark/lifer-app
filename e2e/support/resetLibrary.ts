// Empties the signed-in account's library, for a spec whose counts need a clean start: the
// signed-in specs share one database, and earlier ones leave photos, albums, trips, pins, seen
// marks and checklist additions behind. The account, settings and downloaded packs stay.
// Mirrors the app's own library delete (settings/deleteLocalLibrary.ts); everything that
// hangs off a capture, trip or album goes with it by cascade.
import pg from "pg";
import { LOCAL_DATABASE_URL } from "./constants.js";

export async function resetLibrary(): Promise<void> {
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? LOCAL_DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query<{ db: string }>("SELECT pg_catalog.current_database() AS db");
    if (!rows[0].db.includes("e2e")) throw new Error(`Refusing to empty "${rows[0].db}": not an e2e database`);
    await db.query("BEGIN");
    // As the app's own delete does: no sync tombstones, which apps would read as removed marks.
    await db.query("SELECT set_config('lifer.sync_apply', 'on', true)");
    for (const table of [
      // Albums and trips point at photos as covers, so they go first.
      "albums",
      "trips",
      "user_species",
      "captures_all",
      "region_species_user_added",
      "sea_zone_species_user_added",
      "user_archived_species",
    ])
      await db.query(`DELETE FROM ${table}`);
    await db.query("DELETE FROM install_settings WHERE key LIKE 'pinned_filters:%'");
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await db.end();
  }
}
