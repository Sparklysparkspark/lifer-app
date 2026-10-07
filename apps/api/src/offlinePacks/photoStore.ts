// Pack photos come from the shared photo store (packages/data-pipeline/src/pipeline/photoStore.ts),
// not the pack: an install fetches by byte range only the photos it doesn't have yet.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { Pool, PoolClient } from "pg";
import { APP_DATA_DIR } from "@lifer/core/config.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type PhotoRef = [shard: number, offset: number, length: number, sha1: string];
interface PhotoPair {
  d?: PhotoRef;
  t?: PhotoRef;
}
export interface PhotoStoreIndex {
  v: 1;
  builtAt: string;
  shards: Array<{ name: string; bytes: number; sha256: string }>;
  species: Record<string, PhotoPair & { g?: Record<string, PhotoPair> }>;
}

const INDEX_TTL_MS = 15 * 60_000;
let cached: { url: string; at: number; index: PhotoStoreIndex } | null = null;

export async function fetchPhotoStoreIndex(indexUrl: string, opts: { fresh?: boolean } = {}): Promise<PhotoStoreIndex> {
  if (!opts.fresh && cached && cached.url === indexUrl && Date.now() - cached.at < INDEX_TTL_MS) return cached.index;
  const res = await fetch(indexUrl, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Couldn't fetch the pack photo index (${res.status})`);
  const index = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8")) as PhotoStoreIndex;
  cached = { url: indexUrl, at: Date.now(), index };
  return index;
}

/** Shard files sit beside the index. */
const shardUrl = (indexUrl: string, name: string) => new URL(name, indexUrl).toString();

export const PHOTO_DIRS = {
  display: path.join(APP_DATA_DIR, "reference-display"),
  thumb: path.join(APP_DATA_DIR, "reference-thumb"),
  galleryDisplay: path.join(APP_DATA_DIR, "reference-gallery-display"),
  galleryThumb: path.join(APP_DATA_DIR, "reference-gallery-thumb"),
};

interface Need {
  ref: PhotoRef;
  dest: string;
  /** The row and column the file's path is written to once it's saved. */
  target: { kind: "main"; speciesId: string; column: "reference_display_path" | "reference_thumb_path" } | { kind: "gallery"; photoId: string; column: "display_path" | "thumb_path" };
}

/** The store photos these species are missing on this install: main photos always, gallery
 *  photos unless `includeGallery` is false. `checkFiles` also treats a recorded path whose file
 *  is gone as missing. */
export async function missingPhotos(
  db: Queryable,
  index: PhotoStoreIndex,
  speciesIds: string[],
  includeGallery: boolean,
  checkFiles = true,
): Promise<Need[]> {
  if (speciesIds.length === 0) return [];
  const ids = speciesIds.filter((id) => index.species[id]);
  if (ids.length === 0) return [];
  const has = (p: string | null) => p != null && (!checkFiles || existsSync(p));
  const needs: Need[] = [];
  const main = await db.query<{ id: string; reference_display_path: string | null; reference_thumb_path: string | null }>(
    `SELECT id, reference_display_path, reference_thumb_path FROM species WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  for (const r of main.rows) {
    const entry = index.species[r.id];
    if (entry.d && !has(r.reference_display_path)) {
      needs.push({ ref: entry.d, dest: path.join(PHOTO_DIRS.display, `${r.id}.webp`), target: { kind: "main", speciesId: r.id, column: "reference_display_path" } });
    }
    if (entry.t && !has(r.reference_thumb_path)) {
      needs.push({ ref: entry.t, dest: path.join(PHOTO_DIRS.thumb, `${r.id}.webp`), target: { kind: "main", speciesId: r.id, column: "reference_thumb_path" } });
    }
  }
  if (includeGallery) {
    const gallery = await db.query<{ id: string; species_id: string; photo_url: string; sort_order: number; display_path: string | null; thumb_path: string | null }>(
      `SELECT id, species_id, photo_url, sort_order, display_path, thumb_path FROM species_reference_photos WHERE species_id = ANY($1::uuid[])`,
      [ids],
    );
    for (const g of gallery.rows) {
      const pair = index.species[g.species_id]?.g?.[g.photo_url];
      if (!pair) continue;
      if (pair.d && !has(g.display_path)) {
        needs.push({ ref: pair.d, dest: path.join(PHOTO_DIRS.galleryDisplay, `${g.species_id}-${g.sort_order}.webp`), target: { kind: "gallery", photoId: g.id, column: "display_path" } });
      }
      if (pair.t && !has(g.thumb_path)) {
        needs.push({ ref: pair.t, dest: path.join(PHOTO_DIRS.galleryThumb, `${g.species_id}-${g.sort_order}.webp`), target: { kind: "gallery", photoId: g.id, column: "thumb_path" } });
      }
    }
  }
  return needs;
}

const bytesOf = (needs: Array<{ ref: PhotoRef }>) => needs.reduce((a, n) => a + n.ref[2], 0);

// Photos next to each other in a shard are fetched in one request when the gap between them is
// small, up to a cap per request.
const MAX_GAP_BYTES = 256 * 1024;
const MAX_RANGE_BYTES = 32 * 1024 * 1024;

export interface ByteRange<T> {
  shard: number;
  start: number;
  end: number; // exclusive
  items: T[];
}

/** Groups photos into as few byte ranges as it can, per shard and in order. */
export function planRanges<T extends { ref: PhotoRef }>(items: T[]): Array<ByteRange<T>> {
  const sorted = [...items].sort((a, b) => a.ref[0] - b.ref[0] || a.ref[1] - b.ref[1]);
  const ranges: Array<ByteRange<T>> = [];
  for (const item of sorted) {
    const [shard, offset, length] = item.ref;
    const last = ranges[ranges.length - 1];
    if (last && last.shard === shard && offset - last.end <= MAX_GAP_BYTES && offset + length - last.start <= MAX_RANGE_BYTES) {
      last.end = Math.max(last.end, offset + length);
      last.items.push(item);
    } else {
      ranges.push({ shard, start: offset, end: offset + length, items: [item] });
    }
  }
  return ranges;
}

/** Downloads the photos, checks each one's SHA-1, saves it, and records its path. A photo that
 *  fails its check is skipped rather than failing the pack: the checklist is already installed. */
export async function downloadPhotos(
  db: Queryable,
  indexUrl: string,
  index: PhotoStoreIndex,
  needs: Need[],
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; assertUrl?: (url: string) => void; concurrency?: number } = {},
): Promise<{ saved: number; failed: number; bytes: number }> {
  for (const dir of Object.values(PHOTO_DIRS)) mkdirSync(dir, { recursive: true });
  const ranges = planRanges(needs);
  const total = bytesOf(needs);
  let done = 0;
  let saved = 0;
  let failed = 0;
  const written: Need[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ranges.length) {
      const range = ranges[next++];
      opts.signal?.throwIfAborted();
      const url = shardUrl(indexUrl, index.shards[range.shard].name);
      opts.assertUrl?.(url);
      let body: Buffer | null = null;
      for (let attempt = 0; attempt < 4 && !body; attempt++) {
        try {
          const timeout = AbortSignal.timeout(120_000);
          const res = await fetch(url, {
            headers: { Range: `bytes=${range.start}-${range.end - 1}` },
            signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
          });
          if (res.status === 206) {
            body = Buffer.from(await res.arrayBuffer());
            continue;
          }
          // Not read, so release the connection (a 200 would be the whole shard).
          await res.body?.cancel().catch(() => {});
          if (res.status === 429 || res.status >= 500) await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
          else throw new Error(`Photo download returned ${res.status}`);
        } catch (err) {
          if (opts.signal?.aborted) throw err;
          await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        }
      }
      for (const item of range.items) {
        const [, offset, length, sha1] = item.ref;
        const bytes = body?.subarray(offset - range.start, offset - range.start + length);
        if (!bytes || bytes.length !== length || createHash("sha1").update(bytes).digest("hex") !== sha1) {
          failed++;
          continue;
        }
        const tmp = `${item.dest}.part`;
        writeFileSync(tmp, bytes);
        renameSync(tmp, item.dest);
        written.push(item);
        saved++;
      }
      done += range.end - range.start;
      opts.onProgress?.(Math.min(done, total), total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, ranges.length) }, worker));

  // Paths are recorded once every file is on disk, so nothing points at a file that isn't there.
  for (const column of ["reference_display_path", "reference_thumb_path"] as const) {
    const rows = written.filter((w) => w.target.kind === "main" && w.target.column === column);
    if (rows.length > 0) {
      await db.query(
        `UPDATE species s SET ${column} = v.p, enriched_at = COALESCE(s.enriched_at, now())
         FROM unnest($1::uuid[], $2::text[]) AS v(id, p) WHERE s.id = v.id`,
        [rows.map((r) => (r.target as { speciesId: string }).speciesId), rows.map((r) => r.dest)],
      );
    }
  }
  for (const column of ["display_path", "thumb_path"] as const) {
    const rows = written.filter((w) => w.target.kind === "gallery" && w.target.column === column);
    if (rows.length > 0) {
      await db.query(
        `UPDATE species_reference_photos p SET ${column} = v.p FROM unnest($1::uuid[], $2::text[]) AS v(id, p) WHERE p.id = v.id`,
        [rows.map((r) => (r.target as { photoId: string }).photoId), rows.map((r) => r.dest)],
      );
    }
  }
  return { saved, failed, bytes: total };
}
