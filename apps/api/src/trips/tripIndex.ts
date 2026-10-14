// A recovery record inside the trip's own folder, so it survives a fresh install. Keyed by
// scientific name, since species ids differ between installs.
// Writes are queued per folder so concurrent imports don't drop entries, and every entry that
// arrives while a write is running goes into the next one, so an import job rewrites the file a
// few times rather than once per photo. Losing one only means reassigning that photo once.
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { writeFileAtomicSync } from "../lib/atomicWrite.js";
import path from "node:path";
import { pool } from "@lifer/core/db.js";

interface TripIndex {
  [relativePath: string]: { scientificName: string };
}

function indexPath(sourceFolder: string): string {
  return path.join(sourceFolder, ".lifer", "index.json");
}

async function readTripIndex(sourceFolder: string): Promise<TripIndex> {
  try {
    return JSON.parse(await readFile(indexPath(sourceFolder), "utf8")) as TripIndex;
  } catch {
    return {};
  }
}

const writeQueues = new Map<string, Promise<void>>();
// Entries not written yet, and the queued write (not yet started) that will take them.
const pendingEntries = new Map<string, Map<string, string>>();
const queuedWrites = new Map<string, Promise<void>>();

export function recordTripIndexEntry(
  sourceFolder: string,
  relativePath: string,
  scientificName: string,
): Promise<void> {
  let entries = pendingEntries.get(sourceFolder);
  if (!entries) pendingEntries.set(sourceFolder, (entries = new Map()));
  entries.set(relativePath, scientificName);
  const queued = queuedWrites.get(sourceFolder);
  if (queued) return queued;

  const prior = writeQueues.get(sourceFolder) ?? Promise.resolve();
  const next = prior
    .catch(() => {
      // One failed write mustn't block the rest; the index is best effort.
    })
    .then(async () => {
      queuedWrites.delete(sourceFolder);
      const batch = pendingEntries.get(sourceFolder);
      pendingEntries.delete(sourceFolder);
      if (!batch || batch.size === 0) return;
      await mkdir(path.join(sourceFolder, ".lifer"), { recursive: true });
      const index = await readTripIndex(sourceFolder);
      for (const [p, name] of batch) index[p] = { scientificName: name };
      writeFileAtomicSync(indexPath(sourceFolder), JSON.stringify(index, null, 2));
    });
  queuedWrites.set(sourceFolder, next);
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
  const index = await readTripIndex(sourceFolder);
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
