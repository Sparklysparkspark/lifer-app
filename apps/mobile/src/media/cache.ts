// The phone's photo copies. Thumbnails (400 px) live under a cap, least recently used first out;
// the showcase (2048 px covers and Favourites, and the 1024 px squares of cards and covers) is kept; a full-size render lives for an hour.
// Files and the network are injected (expoMedia.ts), so the rules here run in plain tests.
import type { Db } from "../store/db";
import { SPECIES_SQL } from "../store/marks";
import type { Settings } from "../store/settings";

export type MediaKind = "thumb" | "view" | "phone" | "full";

export interface DownloadTarget {
  url: string;
  headers: Record<string, string>;
  certSha256?: string;
}

/** An HTTP answer that was not a photo (404: none, 409: the drive is not connected). */
export class MediaHttpError extends Error {
  constructor(readonly status: number) {
    super(`photo request answered ${status}`);
  }
}

export interface MediaFs {
  /** Streams the target to a file and returns its size. Throws MediaHttpError for a non-photo answer. */
  download(target: DownloadTarget, destPath: string): Promise<number>;
  remove(path: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
}

export interface MediaDeps {
  db: Db;
  fs: MediaFs;
  dirs: Record<MediaKind, string>;
  target: (path: string) => DownloadTarget;
  now: () => number;
  settings: () => Settings;
  /** Whether the connection costs money (cellular, Low Data Mode). */
  metered: () => Promise<boolean>;
}

export const FULL_LIFETIME_MS = 60 * 60_000;

/** A species' reference photo travels through the photo cache under this id (the name as the hub's phone routes spell it). */
export const referenceId = (scientificName: string): string => `ref~${scientificName.replace(/[^A-Za-z0-9-]/g, "_")}`;

export const mediaPath = (d: Pick<MediaDeps, "dirs">, kind: MediaKind, photoId: string): string =>
  `${d.dirs[kind]}/${photoId.replace(/~/g, "_")}.${kind === "full" ? "jpg" : kind === "thumb" ? "img" : "webp"}`;

export type SquareKind = "species" | "album" | "trip";

/** A featured photo cut square by the hub (1024 px, the user's crop): kept in the showcase under an id that
 *  carries the crop, so a new crop is a new id and the old file is dropped. The owner is a species' slug
 *  (as referenceId spells it) or an album or trip id. */
export const squareId = (kind: SquareKind, owner: string, photoId: string, crop: { x: number; y: number; size: number } | null): string =>
  `sq~${kind}~${owner}~${photoId}~${crop ? [crop.x, crop.y, crop.size].map((n) => n.toFixed(3)).join("_") : "centre"}`;

/** "view" is a 2048 px copy kept under the thumbnail cap; "phone" is the same size, kept in the showcase. */
export const hubPath = (kind: MediaKind, photoId: string): string =>
  photoId.startsWith("sq~")
    ? `/companion/v1/square/${photoId.split("~")[1]}/${photoId.split("~")[2]}?photo=${photoId.split("~")[3]}`
    : photoId.startsWith("ref~")
    ? `/companion/v1/reference/${photoId.slice(4)}/${kind === "thumb" ? "thumb" : "display"}`
    : `/photos/${photoId}/${kind === "full" ? "full" : kind === "thumb" ? "thumb" : "phone"}`;

/** MR14: with Wi-Fi only on, no photo is downloaded over a metered connection. */
export async function downloadsAllowed(d: Pick<MediaDeps, "settings" | "metered">): Promise<boolean> {
  return !d.settings().wifiOnly || !(await d.metered());
}

interface MediaRow {
  photo_id: string;
  kind: MediaKind;
  path: string;
  bytes: number;
  last_used: number;
}

export async function cached(d: MediaDeps, kind: MediaKind, photoId: string): Promise<string | null> {
  const row = await d.db.get<MediaRow>("SELECT * FROM media WHERE photo_id = ? AND kind = ?", [photoId, kind]);
  return row?.path ?? null;
}

export const touch = (d: MediaDeps, kind: MediaKind, photoId: string): Promise<void> =>
  d.db.run("UPDATE media SET last_used = ? WHERE photo_id = ? AND kind = ?", [d.now(), photoId, kind]);

/** What to delete so the total is at most cap: least recently used first. Pure. */
export function planEviction(rows: Pick<MediaRow, "photo_id" | "kind" | "bytes" | "last_used">[], cap: number) {
  let total = rows.reduce((n, r) => n + r.bytes, 0);
  const out: typeof rows = [];
  for (const r of [...rows].sort((a, b) => a.last_used - b.last_used)) {
    if (total <= cap) break;
    out.push(r);
    total -= r.bytes;
  }
  return out;
}

async function drop(d: MediaDeps, row: MediaRow): Promise<void> {
  await d.fs.remove(row.path).catch(() => undefined);
  await d.db.run("DELETE FROM media WHERE photo_id = ? AND kind = ?", [row.photo_id, row.kind]);
}

/** Forgets one saved copy (its file and its row), so the next request downloads it again. */
export async function forgetMedia(d: MediaDeps, kind: MediaKind, photoId: string): Promise<void> {
  const row = await d.db.get<MediaRow>("SELECT * FROM media WHERE photo_id = ? AND kind = ?", [photoId, kind]);
  if (row) await drop(d, row);
}

/** Brings thumbnails and viewed copies back under the cap. Returns how many were removed. */
export async function enforceThumbCap(d: MediaDeps, cap = d.settings().thumbCapBytes): Promise<number> {
  const rows = await d.db.all<MediaRow>("SELECT * FROM media WHERE kind IN ('thumb', 'view')");
  const doomed = planEviction(rows, cap);
  for (const r of doomed) await drop(d, rows.find((x) => x.photo_id === r.photo_id)!);
  return doomed.length;
}

/** Removes full-size renders older than an hour. */
export async function purgeFull(d: MediaDeps): Promise<void> {
  const rows = await d.db.all<MediaRow>("SELECT * FROM media WHERE kind = 'full' AND last_used < ?", [
    d.now() - FULL_LIFETIME_MS,
  ]);
  for (const r of rows) await drop(d, r);
}

export interface Usage {
  /** Thumbnails and viewed copies, the part under the cap. */
  thumb: number;
  phone: number;
  full: number;
}

export async function usage(db: Db): Promise<Usage> {
  const out: Usage = { thumb: 0, phone: 0, full: 0 };
  for (const r of await db.all<{ kind: MediaKind; n: number }>("SELECT kind, sum(bytes) AS n FROM media GROUP BY kind"))
    out[r.kind === "view" ? "thumb" : r.kind] += Number(r.n);
  return out;
}

/** Downloads one copy and records it. A partial file is never recorded. */
export async function fetchMedia(d: MediaDeps, kind: MediaKind, photoId: string): Promise<string> {
  const have = await cached(d, kind, photoId);
  if (have) {
    await touch(d, kind, photoId);
    return have;
  }
  await d.fs.ensureDir(d.dirs[kind]);
  const path = mediaPath(d, kind, photoId);
  const bytes = await d.fs.download(d.target(hubPath(kind, photoId)), path);
  await d.db.run("INSERT OR REPLACE INTO media (photo_id, kind, path, bytes, last_used) VALUES (?, ?, ?, ?, ?)", [
    photoId,
    kind,
    path,
    bytes,
    d.now(),
  ]);
  return path;
}

export const ESTIMATED_SHOWCASE_BYTES = 750 * 1024;

/**
 * The showcase: every species' cover photo and the Favourites album, or Favourites only. Ids with no
 * copy yet, covers first. The size to show before the person turns it on is count * 750 KB.
 */
export async function showcaseMissing(
  d: MediaDeps,
  favourites: string[],
): Promise<{ ids: string[]; total: number }> {
  const covers = d.settings().showcaseFavouritesOnly
    ? []
    : (
        await d.db.all<{ id: string }>(
          `SELECT DISTINCT cover AS id FROM (${SPECIES_SQL}) WHERE cover IS NOT NULL AND photos > 0`,
        )
      )
        .map((r) => r.id)
        .filter((id) => id !== null);
  const all = [...new Set([...covers, ...favourites])];
  const have = new Set(
    (await d.db.all<{ photo_id: string }>("SELECT photo_id FROM media WHERE kind = 'phone'")).map((r) => r.photo_id),
  );
  return { ids: all.filter((id) => !have.has(id)), total: all.length };
}

/** Removes this owner's squares cut for an earlier photo or crop. */
export async function dropStaleSquares(d: MediaDeps, kind: SquareKind, owner: string, keep: string): Promise<void> {
  const prefix = `sq~${kind}~${owner}~`;
  for (const r of await d.db.all<MediaRow>("SELECT * FROM media WHERE kind = 'phone' AND substr(photo_id, 1, ?) = ? AND photo_id <> ?", [
    prefix.length,
    prefix,
    keep,
  ]))
    await drop(d, r);
}

/** Empties one kind of copy (the showcase or the thumbnails). */
export async function clearKind(d: MediaDeps, kind: MediaKind): Promise<void> {
  for (const r of await d.db.all<MediaRow>("SELECT * FROM media WHERE kind = ?", [kind])) await drop(d, r);
}

export type FullResult = { ok: true; path: string } | { ok: false; reason: "offline" | "unavailable" };

/** "View full size": a full render from the hub, kept an hour. Offline or refused, the caller keeps the saved copy. */
export async function fetchFull(d: MediaDeps, photoId: string): Promise<FullResult> {
  await purgeFull(d);
  try {
    return { ok: true, path: await fetchMedia(d, "full", photoId) };
  } catch (e) {
    return { ok: false, reason: e instanceof MediaHttpError ? "unavailable" : "offline" };
  }
}
