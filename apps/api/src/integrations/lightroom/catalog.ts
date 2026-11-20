// Reads a Lightroom Classic catalogue (.lrcat, a SQLite file) without changing it: opened read-only,
// on a temporary copy while Lightroom has the catalogue open. Nothing here writes to the file.
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { pool } from "@lifer/core/db.js";
import { parseLuaTable } from "./luaTable.js";
import { mapSmartRules } from "./smartRules.js";
import type { AlbumChange, ChangeSet, LightroomFlag, PhotoChange, Unmapped } from "./types.js";

const YIELD_EVERY = 2000; // node:sqlite is synchronous, so long reads give the server room to answer

interface ImageRow {
  id: number;
  rating: number | null;
  pick: number | null;
  label: string | null;
  captureTime: string | null;
  baseName: string;
  extension: string | null;
  pathFromRoot: string | null;
  absolutePath: string | null;
  lat: number | null;
  lon: number | null;
  caption: string | null;
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** The path a Lightroom photo has on disk, in this computer's separators. */
export function imagePath(row: Pick<ImageRow, "absolutePath" | "pathFromRoot" | "baseName" | "extension">): string {
  const file = row.extension ? `${row.baseName}.${row.extension}` : row.baseName;
  // Lightroom stores forward slashes everywhere, even on Windows.
  return path.normalize(`${row.absolutePath ?? ""}${row.pathFromRoot ?? ""}${file}`);
}

// Case and separators ignored, since a catalogue can come from another system or a case-insensitive drive.
const pathKey = (p: string) => p.replace(/\\/g, "/").toLowerCase();

async function openReadOnly(file: string): Promise<{ db: DatabaseSync; cleanup: () => Promise<void> }> {
  // Lightroom writes a lock file beside the catalogue while it has it open, and a journal mid-write.
  const busy = (await exists(`${file}-lock`)) || (await exists(`${file}-journal`)) || (await exists(`${file}.lock`));
  if (!busy) return { db: new DatabaseSync(file, { readOnly: true }), cleanup: async () => {} };
  const dir = await mkdtemp(path.join(os.tmpdir(), "lifer-lrcat-"));
  const copy = path.join(dir, "catalog.lrcat");
  await copyFile(file, copy);
  return {
    db: new DatabaseSync(copy, { readOnly: true }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function* rowsOf<T>(db: DatabaseSync, sql: string): AsyncGenerator<T> {
  let n = 0;
  for (const row of db.prepare(sql).iterate()) {
    yield row as T;
    if (++n % YIELD_EVERY === 0) await yieldToLoop();
  }
}

const flagOf = (pick: number | null): LightroomFlag | null => (pick === 1 ? "pick" : pick === -1 ? "reject" : null);
const ratingOf = (r: number | null) => (r && r >= 1 ? Math.min(5, Math.round(r)) : null);

interface Lifer {
  captureId: string;
  takenAtMs: number | null;
  rating: number | null;
  flag: LightroomFlag | null;
  lat: number | null;
  lon: number | null;
  tags: string[];
}

interface LiferIndex {
  byPath: Map<string, Lifer>;
  byName: Map<string, Lifer[]>;
}

const nameKey = (p: string) => path.basename(pathKey(p));
// Lightroom's capture time has no zone, so a moved or renamed-folder file matches by name when one
// photo of that name was taken within a day (the widest zone gap) of it.
const SAME_PHOTO_WINDOW_MS = 14 * 3600_000;

function matchOf(index: LiferIndex, filePath: string, takenAt: string | null): Lifer | null {
  const exact = index.byPath.get(pathKey(filePath));
  if (exact) return exact;
  const wall = takenAt ? Date.parse(`${takenAt.slice(0, 19)}Z`) : NaN;
  if (Number.isNaN(wall)) return null;
  const near = (index.byName.get(nameKey(filePath)) ?? []).filter(
    (l) => l.takenAtMs !== null && Math.abs(l.takenAtMs - wall) <= SAME_PHOTO_WINDOW_MS,
  );
  return near.length === 1 ? near[0] : null;
}

/** Lifer's photos by file path and by file name: every file Lifer holds an original of, for this user. */
async function liferIndex(userId: string): Promise<LiferIndex> {
  const res = await pool.query<{
    ref: string;
    id: string;
    quality_rating: number | null;
    cull_verdict: LightroomFlag | null;
    lat: number | null;
    lon: number | null;
    tags: string[];
    taken_at: Date | null;
  }>(
    `SELECT o.ref, c.id, c.taken_at, c.quality_rating, c.cull_verdict, c.lat::float8 AS lat, c.lon::float8 AS lon, c.tags
     FROM originals o JOIN captures c ON c.id = o.capture_id
     WHERE o.user_id = $1`,
    [userId],
  );
  const byPath = new Map<string, Lifer>();
  const byName = new Map<string, Lifer[]>();
  for (const r of res.rows) {
    const entry: Lifer = {
      captureId: r.id,
      takenAtMs: r.taken_at ? r.taken_at.getTime() : null,
      rating: r.quality_rating,
      flag: r.cull_verdict,
      lat: r.lat,
      lon: r.lon,
      tags: r.tags,
    };
    byPath.set(pathKey(r.ref), entry);
    byName.set(nameKey(r.ref), [...(byName.get(nameKey(r.ref)) ?? []), entry]);
  }
  return { byPath, byName };
}

/** Reads the catalogue at `file` and works out what it would change for this user's Lifer library. */
export async function readCatalog(file: string, userId: string): Promise<ChangeSet> {
  const { db, cleanup } = await openReadOnly(file);
  try {
    const lifer = await liferIndex(userId);

    // Keywords: each photo's names and their paths through the hierarchy.
    const keywords = new Map<number, { name: string; parent: number | null }>();
    for await (const k of rowsOf<{ id: number; name: string | null; parent: number | null }>(
      db,
      `SELECT id_local AS id, name, parent FROM AgLibraryKeyword`,
    ))
      if (k.name) keywords.set(k.id, { name: k.name, parent: k.parent });
    const keywordPath = (id: number): string => {
      const names: string[] = [];
      // The hierarchy's root is Lightroom's own unnamed one; a depth cap guards a damaged loop.
      for (
        let k = keywords.get(id), depth = 0;
        k && depth < 20;
        k = k.parent ? keywords.get(k.parent) : undefined, depth++
      )
        names.unshift(k.name);
      return names.join(" > ");
    };
    const keywordsByImage = new Map<number, number[]>();
    for await (const link of rowsOf<{ image: number; tag: number }>(db, `SELECT image, tag FROM AgLibraryKeywordImage`))
      keywordsByImage.set(link.image, [...(keywordsByImage.get(link.image) ?? []), link.tag]);

    const photos: PhotoChange[] = [];
    const notInLifer: string[] = [];
    const byImage = new Map<number, { path: string; captureId: string | null }>();
    // Virtual copies share their master's file and are left out.
    for await (const row of rowsOf<ImageRow>(
      db,
      `SELECT i.id_local AS id, i.rating, i.pick, i.colorLabels AS label, i.captureTime,
              f.baseName, f.extension, fo.pathFromRoot, r.absolutePath,
              ex.gpsLatitude AS lat, ex.gpsLongitude AS lon, ip.caption
       FROM Adobe_images i
       JOIN AgLibraryFile f ON f.id_local = i.rootFile
       JOIN AgLibraryFolder fo ON fo.id_local = f.folder
       JOIN AgLibraryRootFolder r ON r.id_local = fo.rootFolder
       LEFT JOIN AgHarvestedExifMetadata ex ON ex.image = i.id_local
       LEFT JOIN AgLibraryIPTC ip ON ip.image = i.id_local
       WHERE i.masterImage IS NULL`,
    )) {
      const filePath = imagePath(row);
      const match = matchOf(lifer, filePath, row.captureTime);
      if (!match) notInLifer.push(filePath);
      byImage.set(row.id, { path: filePath, captureId: match?.captureId ?? null });
      const tags = keywordsByImage.get(row.id) ?? [];
      photos.push({
        captureId: match?.captureId ?? null,
        path: filePath,
        rating: ratingOf(row.rating),
        flag: flagOf(row.pick),
        label: row.label?.trim() || null,
        keywords: tags.flatMap((id) => (keywords.has(id) ? [keywords.get(id)!.name] : [])),
        keywordPaths: tags.flatMap((id) => (keywords.has(id) ? [keywordPath(id)] : [])),
        caption: row.caption?.trim() || null,
        lat: row.lat ?? null,
        lon: row.lon ?? null,
        takenAt: row.captureTime,
        current: match && { rating: match.rating, flag: match.flag, lat: match.lat, lon: match.lon, tags: match.tags },
      });
    }

    const { albums, unmapped } = await readCollections(db, byImage);
    return { photos, albums, unmapped, notInLifer, total: photos.length };
  } finally {
    db.close();
    await cleanup();
  }
}

async function readCollections(
  db: DatabaseSync,
  byImage: Map<number, { path: string; captureId: string | null }>,
): Promise<{ albums: AlbumChange[]; unmapped: Unmapped[] }> {
  interface Collection {
    id: number;
    name: string | null;
    parent: number | null;
    creationId: string | null;
    content: string | null;
  }
  const collections = new Map<number, Collection>();
  for await (const c of rowsOf<Collection>(
    db,
    `SELECT c.id_local AS id, c.name, c.parent, c.creationId, cc.content
     FROM AgLibraryCollection c
     LEFT JOIN AgLibraryCollectionContent cc ON cc.collection = c.id_local AND cc.owningModule LIKE '%smart_collection%'`,
  ))
    collections.set(c.id, c);
  const members = new Map<number, number[]>();
  for await (const m of rowsOf<{ collection: number; image: number }>(
    db,
    `SELECT collection, image FROM AgLibraryCollectionImage`,
  ))
    members.set(m.collection, [...(members.get(m.collection) ?? []), m.image]);

  const setPath = (c: Collection): string[] => {
    const names: string[] = [];
    for (
      let p = c.parent ? collections.get(c.parent) : undefined, depth = 0;
      p && depth < 20;
      p = p.parent ? collections.get(p.parent) : undefined, depth++
    )
      if (p.name) names.unshift(p.name);
    return names;
  };

  const albums: AlbumChange[] = [];
  const unmapped: Unmapped[] = [];
  for (const c of collections.values()) {
    const name = c.name?.trim();
    const kind = c.creationId ?? "";
    if (!name || kind.endsWith(".group") || kind.endsWith(".quick_collection")) continue;
    if (kind.endsWith(".smart_collection")) {
      try {
        const mapped = c.content ? mapSmartRules(parseLuaTable(c.content)) : { reason: "It has no rules" };
        if ("rules" in mapped) albums.push({ name, path: setPath(c), captureIds: [], missing: 0, rules: mapped.rules });
        else unmapped.push({ kind: "smartCollection", name, reason: mapped.reason });
      } catch (err) {
        unmapped.push({ kind: "smartCollection", name, reason: (err as Error).message });
      }
    } else if (kind.endsWith(".collection")) {
      const images = (members.get(c.id) ?? []).flatMap((id) => (byImage.has(id) ? [byImage.get(id)!] : []));
      const captureIds = [...new Set(images.flatMap((i) => (i.captureId ? [i.captureId] : [])))];
      albums.push({ name, path: setPath(c), captureIds, missing: images.length - captureIds.length, rules: null });
    } else
      unmapped.push({
        kind: "publishService",
        name,
        reason: "It is a publish service collection, which Lifer doesn't import",
      });
  }
  return { albums, unmapped };
}
