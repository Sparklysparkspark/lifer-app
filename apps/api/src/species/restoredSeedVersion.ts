// The desktop app restores its bundled catalog seed with psql before the API starts
// (apps/desktop/src-tauri/src/embedded_db.rs), which doesn't record the seed's version in
// install_settings. Without one, Settings offers the catalog the install already has as an
// update. At startup, seedCatalogIfEmpty calls this for a catalog it didn't load itself: it
// records the version from the manifest bundled next to the seed, but only when it can be sure
// that seed is what's in the database.
import path from "node:path";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { BUNDLED_CATALOG_SEED_DIR } from "@lifer/core/config.js";
import { log } from "@lifer/core/lib/log.js";

/** Where a bundled seed and its catalog-manifest.json can be: the Docker image's (and a dev
 *  checkout's) catalog-seed folder, and the desktop app's resources/catalog-seed, which sits two
 *  levels above the compiled server it launches (resources/api/dist/index.js). */
export function bundledCatalogSeedDirs(): string[] {
  const dirs = [BUNDLED_CATALOG_SEED_DIR];
  const entry = process.argv[1];
  if (entry) dirs.push(path.join(path.dirname(entry), "..", "..", "catalog-seed"));
  return dirs;
}

function bundledManifestVersion(dirs: string[]): number | null {
  for (const dir of dirs) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, "catalog-manifest.json"), "utf8")) as {
        version?: unknown;
      };
      if (typeof manifest.version === "number" && Number.isFinite(manifest.version)) return manifest.version;
    } catch {
      // Not here (or unreadable): try the next place.
    }
  }
  return null;
}

/** Records the bundled seed's version for a catalog restored without one. Returns the version
 *  recorded, or null when nothing was.
 *
 *  The bundled seed only reaches the database on a brand-new install: an existing install keeps
 *  its catalog when the app is updated, even though the update bundles a newer seed. So the
 *  version is recorded only when the database was created in the current Postgres run (its first
 *  migration applied after the server started), which is when the desktop restores the seed it
 *  ships. Otherwise nothing is recorded and Settings keeps offering an update, which is harmless:
 *  applying it records the version. */
export async function recordRestoredSeedVersion(
  db: Pool,
  dirs: string[] = bundledCatalogSeedDirs(),
): Promise<number | null> {
  const version = bundledManifestVersion(dirs);
  if (version == null) return null;
  const res = await db.query<{ key: string }>(
    `INSERT INTO install_settings (key, value, updated_at)
     SELECT 'catalog_seed_version', to_jsonb($1::bigint), now()
     WHERE EXISTS (SELECT 1 FROM species)
       AND (SELECT min(applied_at) FROM schema_migrations) >= pg_postmaster_start_time()
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [version],
  );
  if (res.rowCount === 0) return null;
  log.info(`[catalog] recorded the bundled catalog seed's version (${version}) for the catalog restored at install`);
  return version;
}
