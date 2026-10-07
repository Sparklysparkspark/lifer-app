// A recovery record inside the trip's own folder, so it survives a fresh install. Keyed by
// scientific name, since species ids differ between installs.
// Writes are queued per folder so concurrent imports don't drop entries. Losing one only means
// reassigning that photo once.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomicSync } from "../lib/atomicWrite.js";
import path from "node:path";
import { pool } from "@lifer/core/db.js";

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

export function recordTripIndexEntry(
  sourceFolder: string,
  relativePath: string,
  scientificName: string,
): Promise<void> {
  const prior = writeQueues.get(sourceFolder) ?? Promise.resolve();
  const next = prior
    .catch(() => {
      // One failed write mustn't block the rest; the index is best effort.
    })
    .then(() => {
      const dir = path.join(sourceFolder, ".lifer");
      mkdirSync(dir, { recursive: true });
      const index = readTripIndex(sourceFolder);
      index[relativePath] = { scientificName };
      writeFileAtomicSync(indexPath(sourceFolder), JSON.stringify(index, null, 2));
    });
  writeQueues.set(sourceFolder, next);
  // Drop the queue entry once idle so the map doesn't keep one promise per folder forever.
  const cleanup = () => {
    if (writeQueues.get(sourceFolder) === next) writeQueues.delete(sourceFolder);
  };
  next.then(cleanup, cleanup);
  return next;
}

// Maps each relativePath's recorded scientific name to this install's species id.
export async function resolveTripIndexSpecies(
  sourceFolder: string,
  relativePaths: string[],
): Promise<Map<string, string>> {
  if (!existsSync(indexPath(sourceFolder))) return new Map();
  const index = readTripIndex(sourceFolder);
  const scientificNames = [
    ...new Set(relativePaths.map((p) => index[p]?.scientificName).filter((s): s is string => !!s)),
  ];
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
