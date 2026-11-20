import type { Db } from "./db";
import { getMeta, setMeta } from "./meta";

/**
 * Pairing with a Lifer other than the one this phone last synced with: everything that came from the
 * old one goes, and the person's own marks stay, queued to be merged into the new one as if the
 * hub had never been seen. Returns true when anything was reset.
 */
export async function adoptHub(db: Db, instanceId: string): Promise<boolean> {
  const last = await getMeta<string>(db, "hubInstance");
  if (last === instanceId) return false;
  await db.tx(async () => {
    if (last) {
      for (const t of ["captures", "capture_vectors", "capture_frames", "capture_backgrounds", "albums", "album_captures", "saved_spots", "media"]) await db.run(`DELETE FROM ${t}`);
      await db.run("DELETE FROM trips WHERE local = 0");
      await db.run("DELETE FROM regions WHERE source = 'hub'");
      await db.run("DELETE FROM region_species WHERE region_key LIKE 'hub:%'");
      await db.run("DELETE FROM meta WHERE key LIKE 'cursor.%' OR key IN ('prefs', 'lastSyncAt', 'smart.vectors', 'smart.frames')");
      await db.run("UPDATE marks SET hub_version = NULL, cover_photo_id = NULL");
    }
    await db.run(
      "INSERT OR IGNORE INTO outbox (kind, ref, created_at) SELECT 'mark', scientific_name, ? FROM marks",
      [new Date().toISOString()],
    );
    await setMeta(db, "hubInstance", instanceId);
  });
  return last !== null;
}
