// Album membership recorded next to the photos themselves (like tripIndex.ts), so it survives a
// fresh install. Written at two levels: beside the photo (keyed by file name), and consolidated at
// the taxon-group folder two levels up (keyed by relative path), so copying just "Mammals"
// still carries one file that restores those photos' albums.
//
// Rewritten whenever membership changes, and read back by the library reimport (recoverJpeg).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomicSync } from "../lib/atomicWrite.js";
import path from "node:path";
import { pool } from "@lifer/core/db.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";

interface AlbumIndex {
  [relativePath: string]: string[];
}

function indexPath(folder: string): string {
  return path.join(folder, ".lifer", "albums.json");
}

function readAlbumIndex(folder: string): AlbumIndex {
  try {
    return JSON.parse(readFileSync(indexPath(folder), "utf8")) as AlbumIndex;
  } catch {
    return {};
  }
}

// Per-folder write queue, as in tripIndex.ts, so concurrent changes don't race a
// read-modify-write. Best effort: a lost entry means re-adding one photo to its album by hand.
const writeQueues = new Map<string, Promise<void>>();

function queueWrite(folder: string, key: string, albumNames: string[]): Promise<void> {
  const prior = writeQueues.get(folder) ?? Promise.resolve();
  const next = prior
    .catch(() => {})
    .then(() => {
      const dir = path.join(folder, ".lifer");
      mkdirSync(dir, { recursive: true });
      const index = readAlbumIndex(folder);
      if (albumNames.length === 0) delete index[key];
      else index[key] = albumNames;
      writeFileAtomicSync(indexPath(folder), JSON.stringify(index, null, 2));
    });
  writeQueues.set(folder, next);
  // Drop the queue entry once idle so the map doesn't keep one promise per folder forever.
  const cleanup = () => {
    if (writeQueues.get(folder) === next) writeQueues.delete(folder);
  };
  next.then(cleanup, cleanup);
  return next;
}

// The taxon-group folder: two levels above the photo's Adjusted/RAW folder in Lifer's own layout
// (organizedPath.ts).
function taxonGroupFolder(photoFolder: string): string {
  return path.dirname(path.dirname(photoFolder));
}

// Writes each capture's current album membership. Captures without a reachable original are
// skipped.
export async function syncAlbumIndexForCaptures(captureIds: string[]): Promise<void> {
  if (captureIds.length === 0) return;
  const res = await pool.query<{
    capture_id: string;
    ref: string | null;
    volume_id: string | null;
    volume_relative_path: string | null;
    album_names: string[];
  }>(
    `SELECT c.id AS capture_id, o.ref, o.volume_id, o.volume_relative_path,
            COALESCE(array_agg(a.name) FILTER (WHERE a.name IS NOT NULL), '{}') AS album_names
     FROM captures_all c
     LEFT JOIN originals o ON o.capture_id = c.id AND o.kind = 'jpeg'
     LEFT JOIN album_captures ac ON ac.capture_id = c.id
     LEFT JOIN albums a ON a.id = ac.album_id
     WHERE c.id = ANY($1)
     GROUP BY c.id, o.ref, o.volume_id, o.volume_relative_path`,
    [captureIds],
  );

  await Promise.all(
    res.rows.map(async (row) => {
      if (!row.ref) return;
      const resolved = await resolveOriginalPath({ ref: row.ref, volume_id: row.volume_id, volume_relative_path: row.volume_relative_path });
      if (!resolved.connected || !resolved.path) return;
      const folder = path.dirname(resolved.path);
      const filename = path.basename(resolved.path);
      const groupFolder = taxonGroupFolder(folder);
      const relativeToGroup = path.relative(groupFolder, resolved.path);
      await Promise.all([
        queueWrite(folder, filename, row.album_names),
        queueWrite(groupFolder, relativeToGroup, row.album_names),
      ]);
    }),
  );
}

// Recovery: reads the species-folder manifest, then the taxon-group one, and re-adds the capture
// to the albums named there, creating any album that no longer exists.
export async function recoverAlbumMembership(userId: string, absolutePath: string, captureId: string): Promise<void> {
  const folder = path.dirname(absolutePath);
  const filename = path.basename(absolutePath);
  let albumNames = existsSync(indexPath(folder)) ? readAlbumIndex(folder)[filename] : undefined;
  if (!albumNames?.length) {
    const groupFolder = taxonGroupFolder(folder);
    if (existsSync(indexPath(groupFolder))) {
      const relativeToGroup = path.relative(groupFolder, absolutePath);
      albumNames = readAlbumIndex(groupFolder)[relativeToGroup];
    }
  }
  if (!albumNames?.length) return;

  for (const name of albumNames) {
    const existing = await pool.query<{ id: string }>(`SELECT id FROM albums WHERE user_id = $1 AND name = $2 LIMIT 1`, [userId, name]);
    const albumId =
      existing.rows[0]?.id ??
      (await pool.query<{ id: string }>(`INSERT INTO albums (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, name])).rows[0].id;
    await pool.query(`INSERT INTO album_captures (album_id, capture_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [albumId, captureId]);
  }
}
