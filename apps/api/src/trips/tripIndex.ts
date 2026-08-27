// A tiny recovery record written INTO the trip's own folder (never into a photo, never
// anywhere under Lifer's own DATA_DIR) — the one piece of durable state that survives a full
// Lifer reinstall/fresh-database scenario, since it lives wherever the user already keeps and
// backs up their own trip photos, not inside anything Lifer owns.
//
// Species ids are NOT stable across a fresh install (a reseeded species table hands out new
// gen_random_uuid() values even for "the same" species), so the index keys by scientificName
// instead — resolved back to whatever this install's current species id is at read time.
//
// Concurrent imports (IMPORT_CONCURRENCY in routes.ts) all read-modify-write this same file;
// a plain unsynchronized read-modify-write would race and drop entries. Queuing writes
// per-folder keeps them serialized without needing a real file lock — losing a recovery entry
// isn't data loss (the photo just needs manual re-assignment once, same as before this
// existed), so this only needs to be "good," not airtight.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";

interface TripIndex {
  [relativePath: string]: { scientificName: string };
}

function indexPath(sourceFolder: string): string {
  return path.join(sourceFolder, ".lifer", "index.json");
}

function readTripIndex(sourceFolder: string): TripIndex {
  try {
    return JSON.parse(readFileSync(indexPath(sourceFolder), "utf8")) as TripIndex;
  } catch {
    return {};
  }
}

const writeQueues = new Map<string, Promise<void>>();

export function recordTripIndexEntry(sourceFolder: string, relativePath: string, scientificName: string): Promise<void> {
  const prior = writeQueues.get(sourceFolder) ?? Promise.resolve();
  const next = prior
    .catch(() => {
      // A previous write in this chain failing shouldn't poison every write after it — the
      // index is a best-effort recovery aid, not a source of truth.
    })
    .then(() => {
      const dir = path.join(sourceFolder, ".lifer");
      mkdirSync(dir, { recursive: true });
      const index = readTripIndex(sourceFolder);
      index[relativePath] = { scientificName };
      writeFileSync(indexPath(sourceFolder), JSON.stringify(index, null, 2));
    });
  writeQueues.set(sourceFolder, next);
  return next;
}

// For each candidate relativePath, looks up a recorded scientificName in the index and
// resolves it to THIS install's current species id — used by scanTrip to auto-recover a
// previously-imported photo instead of asking the user to reassign it after a fresh install.
export async function resolveTripIndexSpecies(
  sourceFolder: string,
  relativePaths: string[],
): Promise<Map<string, string>> {
  if (!existsSync(indexPath(sourceFolder))) return new Map();
  const index = readTripIndex(sourceFolder);
  const scientificNames = [...new Set(relativePaths.map((p) => index[p]?.scientificName).filter((s): s is string => !!s))];
  if (scientificNames.length === 0) return new Map();

  const speciesRes = await pool.query<{ id: string; scientific_name: string }>(
    `SELECT id, scientific_name FROM species WHERE scientific_name = ANY($1)`,
    [scientificNames],
  );
  const speciesIdByName = new Map(speciesRes.rows.map((r) => [r.scientific_name, r.id]));

  const resolved = new Map<string, string>();
  for (const relativePath of relativePaths) {
    const scientificName = index[relativePath]?.scientificName;
    const speciesId = scientificName ? speciesIdByName.get(scientificName) : undefined;
    if (speciesId) resolved.set(relativePath, speciesId);
  }
  return resolved;
}
