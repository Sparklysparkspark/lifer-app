// Fills the desktop app's offline cache ("Keep an offline cache after connecting") from the
// connected server. Runs only in the server's own page inside the desktop app, the one place
// that holds the server session; the desktop side (apps/desktop/src-tauri/src/offline_cache.rs)
// stores what it's given and never talks to the server itself. Only the collection list and small
// thumbnails of each species' cover are cached, never full photos.
import type { CollectionItem } from "@lifer/shared";
import { mapWithConcurrency } from "./concurrency";
import type { TauriInvoke } from "./tauri";

/** What offline_cache.rs stores per species. */
export interface CacheItem {
  speciesId: string;
  commonName: string | null;
  scientificName: string;
  taxonClass: string | null;
  family: string | null;
  state: "collected" | "seen" | "unseen";
  thumbKey: string | null;
}

/** offline_cache_begin's answer. */
export interface SyncStart {
  syncedAt: number | null;
  /** speciesId -> thumbKey of the thumbnails already on disk. */
  thumbs: Record<string, string>;
  maxThumbs: number;
  maxThumbBytes: number;
}

/** offline_cache_info's answer. */
export interface CacheInfo {
  enabled: boolean;
  syncedAt: number | null;
  species: number;
  thumbs: number;
  bytes: number;
  path: string;
  fromServer: boolean;
}

/** Square crop of the source image, in source pixels. */
export interface Crop {
  sx: number;
  sy: number;
  size: number;
}

export interface ThumbJob {
  speciesId: string;
  url: string;
  key: string;
  item: CollectionItem;
}

// A page load (connecting, app start, or a reload) syncs unless one finished very recently, so
// reloading the window doesn't refetch every time. After that, every half hour.
export const RECENT_SYNC_MS = 2 * 60_000;
export const SYNC_INTERVAL_MS = 30 * 60_000;
export const THUMB_SIZE = 192;

export function isSyncDue(syncedAt: number | null, now: number, firstRun: boolean): boolean {
  if (syncedAt == null) return true;
  const age = now - syncedAt;
  // A clock that moved backwards can't be trusted to say the cache is fresh.
  if (age < 0) return true;
  return age >= (firstRun ? RECENT_SYNC_MS : SYNC_INTERVAL_MS);
}

/** The server's own thumbnail for this card. A reference photo hosted elsewhere is skipped, so
 *  syncing never contacts a third party. */
export function thumbSource(item: Pick<CollectionItem, "coverPhotoUrl">): string | null {
  const url = item.coverPhotoUrl;
  return url && url.startsWith("/api/") ? url : null;
}

/** Changes whenever the card's picture would: a new cover, a new crop or focal point. */
export function thumbKey(item: CollectionItem, url: string): string {
  const parts = [item.cardCropX, item.cardCropY, item.cardCropSize, item.referenceFocalX, item.referenceFocalY];
  return parts.every((p) => p == null) ? url : `${url}#${parts.map((p) => p ?? "").join(",")}`;
}

const PRIORITY: Record<string, number> = { collected: 0, seen: 1 };

/** Which thumbnails to fetch now and which to keep, collected species first, then seen, then the
 *  rest, up to the desktop's limit. */
export function planThumbs(
  items: CollectionItem[],
  cached: Record<string, string>,
  maxThumbs: number,
): { fetch: ThumbJob[]; keep: Map<string, string> } {
  const candidates = items
    .map((item, index) => ({ item, index, url: thumbSource(item) }))
    .filter((c): c is { item: CollectionItem; index: number; url: string } => c.url != null)
    .sort((a, b) => (PRIORITY[a.item.state] ?? 2) - (PRIORITY[b.item.state] ?? 2) || a.index - b.index)
    .slice(0, Math.max(0, maxThumbs));
  const fetch: ThumbJob[] = [];
  const keep = new Map<string, string>();
  for (const { item, url } of candidates) {
    const key = thumbKey(item, url);
    if (cached[item.speciesId] === key) keep.set(item.speciesId, key);
    else fetch.push({ speciesId: item.speciesId, url, key, item });
  }
  return { fetch, keep };
}

export function toCacheItems(items: CollectionItem[], thumbKeys: Map<string, string>): CacheItem[] {
  return items.map((item) => ({
    speciesId: item.speciesId,
    commonName: item.commonName,
    scientificName: item.scientificName,
    taxonClass: item.taxonClass,
    family: item.family,
    state: item.state === "collected" || item.state === "seen" ? item.state : "unseen",
    thumbKey: thumbKeys.get(item.speciesId) ?? null,
  }));
}

/** The square the card shows: the user's crop on their own cover (percent of the width, see
 *  CollectionItem.cardCropX), else the reference focal point, else the centre. */
export function squareCrop(item: CollectionItem, width: number, height: number): Crop {
  if (item.cardCropX != null && item.cardCropY != null && item.cardCropSize != null) {
    const size = Math.max(1, Math.min(width, height, (item.cardCropSize / 100) * width));
    const sx = Math.min(Math.max(0, (item.cardCropX / 100) * width), width - size);
    const sy = Math.min(Math.max(0, (item.cardCropY / 100) * width), height - size);
    return { sx, sy, size };
  }
  const size = Math.min(width, height);
  const fx = (item.referenceFocalX ?? 50) / 100;
  const fy = (item.referenceFocalY ?? 50) / 100;
  // object-position semantics: the focal percentage of the leftover space.
  return { sx: (width - size) * fx, sy: (height - size) * fy, size };
}

export interface SyncDeps {
  invoke: TauriInvoke;
  userId: string;
  fetchCollection: () => Promise<CollectionItem[]>;
  /** A small JPEG of the card's square, or null when it couldn't be made. */
  makeThumb: (job: ThumbJob, maxBytes: number) => Promise<Uint8Array | null>;
  concurrency?: number;
}

export interface SyncResult {
  syncedAt: number;
  species: number;
  fetched: number;
  reused: number;
  failed: number;
}

export async function syncOfflineCache(deps: SyncDeps): Promise<SyncResult> {
  const { invoke, userId } = deps;
  const start = (await invoke("offline_cache_begin", { userId })) as SyncStart;
  const items = await deps.fetchCollection();
  const { fetch, keep } = planThumbs(items, start.thumbs, start.maxThumbs);
  const keys = new Map(keep);
  let fetched = 0;
  let failed = 0;
  await mapWithConcurrency(fetch, deps.concurrency ?? 4, async (job) => {
    try {
      const bytes = await deps.makeThumb(job, start.maxThumbBytes);
      if (bytes && bytes.byteLength <= start.maxThumbBytes) {
        await invoke("offline_cache_put_thumb", bytes, {
          headers: { "x-lifer-user": userId, "x-lifer-species": job.speciesId },
        });
        keys.set(job.speciesId, job.key);
        fetched++;
        return;
      }
    } catch {
      // Counted below; one bad photo doesn't stop the sync.
    }
    failed++;
    // Keep an older thumbnail rather than none; its old key makes the next sync retry.
    const old = start.thumbs[job.speciesId];
    if (old) keys.set(job.speciesId, old);
  });
  const syncedAt = (await invoke("offline_cache_commit", { userId, items: toCacheItems(items, keys) })) as number;
  return { syncedAt, species: items.length, fetched, reused: keep.size, failed };
}

/** Browser implementation of makeThumb: the server's thumbnail, cropped square and re-encoded small. */
export async function makeBrowserThumb(job: ThumbJob, maxBytes: number): Promise<Uint8Array | null> {
  const res = await fetch(job.url, { credentials: "same-origin" });
  if (!res.ok) return null;
  const bitmap = await createImageBitmap(await res.blob());
  try {
    const { sx, sy, size } = squareCrop(job.item, bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, THUMB_SIZE, THUMB_SIZE);
    for (const quality of [0.75, 0.55, 0.4]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!blob) return null;
      if (blob.size <= maxBytes) return new Uint8Array(await blob.arrayBuffer());
    }
    return null;
  } finally {
    bitmap.close();
  }
}
