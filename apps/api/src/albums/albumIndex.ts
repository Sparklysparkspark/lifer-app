// A tiny recovery record written INTO each photo's own on-disk folder — same idea and same
// durability guarantee as trips/tripIndex.ts's own manifest: it survives a full Lifer
// reinstall/fresh-database scenario because it lives wherever the user already keeps (and backs
// up) their own photo files, not inside anything Lifer owns. Trips only ever need ONE manifest
// per import (a whole trip shares one sourceFolder); albums have no such single folder — a
// capture's species folder is whatever it already is — so this writes at TWO levels for
// redundancy: one manifest right next to the photo itself (species-folder level, keyed by
// filename), and one CONSOLIDATED manifest at the taxon-group folder two levels up (e.g.
// "Birds", "Mammals" — see organizedPath.ts, where the taxon-label folder always sits exactly
// two levels above the Adjusted/RAW subfolder regardless of the year/location toggles above it),
// keyed by the path relative to that taxon-group root.
//
// The point of the second copy: someone backing up or copying only a whole top-level group
// (e.g. just "Mammals", not the full library) still gets ONE file at the top of that copy that
// can rebuild every album assignment for whatever photos actually came along — without it, that
// same information would only exist scattered across many deeply-nested per-species .lifer
// folders, any of which a partial copy or a backup tool's own depth limit could drop. An album
// that mixed birds and mammals recovers only its mammal photos from a mammals-only copy — that's
// the correct, honest degraded outcome, not a bug to work around.
//
// Written any time album membership actually changes (see syncAlbumIndexForCaptures, called from
// both the add and remove routes) so it always reflects the CURRENT membership, not just
// additions. Read back during the library reimport tool's recovery pass (recoverJpeg in
// reimport.ts) to restore album membership for a freshly-recovered capture.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
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

// Same per-folder write-queue pattern as tripIndex.ts, for the same reason: concurrent album
// mutations touching the same folder's manifest must not race a read-modify-write against each
// other. Best-effort — losing an entry just means one photo needs manually re-added to its
// album(s) after a fresh install, not real data loss.
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
      writeFileSync(indexPath(folder), JSON.stringify(index, null, 2));
    });
  writeQueues.set(folder, next);
  return next;
}

// The taxon-group folder for a resolved photo path — always exactly two levels above the
// Adjusted/RAW folder the photo itself sits in (species folder, then its parent), regardless of
// whether organize-by-year/organize-by-location put anything else above THAT (see
// originalsFolder in organizedPath.ts: `.../[Wildlife <year>/]<taxon>/<species>/<subfolder>`).
// Only meaningful for Lifer's own organized layout — same assumption the rest of the reimport
// tool already relies on for a managed library.
function taxonGroupFolder(photoFolder: string): string {
  return path.dirname(path.dirname(photoFolder));
}

// Recomputes and writes each given capture's CURRENT album membership — called after both an
// add and a remove, so the manifest always mirrors the real state rather than only ever
// growing. Best-effort throughout: a capture with no resolvable on-disk original (drive
// disconnected, RAW-only, etc.) is silently skipped, same reasoning as everywhere else this
// kind of recovery aid degrades gracefully rather than failing the request over it.
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

// Recovery side, called from reimport.ts's recoverJpeg once a capture is freshly recovered —
// checks the species-folder-level manifest first (the exact match), falling back to the
// consolidated taxon-group-level one if that folder's own .lifer got left behind by whatever
// partial copy this file survived in. Re-adds the capture to whichever albums either names,
// creating an album by that name for this user if one doesn't already exist (the original album
// row is gone in a fresh-install scenario; only its NAME survived, recorded here).
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
