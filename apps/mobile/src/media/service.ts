// What screens talk to: photos by id, from disk when saved and from the hub when not, never
// blocking. Saved copies are remembered in memory so a grid cell knows its picture synchronously.
import type { Db } from "../store/db";
import { favouritePhotoIds } from "../store/library";
import { SPECIES_SQL } from "../store/marks";
import { toCrop, type Crop } from "../photos/crop";
import {
  cached,
  clearKind,
  downloadsAllowed,
  dropStaleSquares,
  enforceThumbCap,
  fetchFull,
  fetchMedia,
  forgetMedia,
  referenceId,
  showcaseMissing,
  squareId,
  touch,
  type FullResult,
  type MediaDeps,
  type MediaKind,
  type SquareKind,
} from "./cache";
import { settled } from "../sync/yield";
import { MediaQueue } from "./queue";

type Listener = (path: string) => void;

export class MediaService {
  private known = new Map<string, string>();
  private watchers = new Map<string, Set<Listener>>();
  private queue: MediaQueue;
  private done = 0;
  private meteredAt = 0;
  private meteredNow = false;
  private running = false;
  private squares = new Map<string, Promise<string | null>>();
  private squareSlots = 4;
  private squareWaiting: Array<() => void> = [];

  constructor(
    private readonly d: MediaDeps,
    /** Whether a hub is paired and answering; without one nothing is requested. */
    private readonly hasHub: () => boolean,
  ) {
    this.queue = new MediaQueue((id) => this.fetchThumb(id));
    this.queue.subscribe((id, path) => this.set("thumb", id, path));
  }

  /** Remembers every saved thumbnail, so the first screen paints with no waiting. */
  async load(): Promise<void> {
    const rows = await this.d.db.all<{ photo_id: string; path: string }>(
      "SELECT photo_id, path FROM media WHERE kind = 'thumb'",
    );
    for (const r of rows) this.known.set(`thumb:${r.photo_id}`, r.path);
  }

  private set(kind: MediaKind, id: string, path: string): void {
    this.known.set(`${kind}:${id}`, path);
    this.watchers.get(`${kind}:${id}`)?.forEach((l) => l(path));
  }

  private async allowed(): Promise<boolean> {
    if (this.d.now() - this.meteredAt > 30_000) {
      this.meteredNow = await this.d.metered();
      this.meteredAt = this.d.now();
    }
    return downloadsAllowed({ settings: this.d.settings, metered: async () => this.meteredNow });
  }

  private async fetchThumb(id: string): Promise<string> {
    if (!this.hasHub() || !(await this.allowed())) throw new Error("not now");
    const path = await fetchMedia(this.d, "thumb", id);
    if (++this.done % 100 === 0) void enforceThumbCap(this.d).catch(() => undefined);
    return path;
  }

  /** The saved thumbnail's path, or null. Asks for it to be fetched when it is not saved. */
  thumb(id: string): string | null {
    const path = this.known.get(`thumb:${id}`) ?? null;
    if (!path) this.queue.request(id);
    return path;
  }

  /** Tells the cell when its picture arrives. */
  watch(id: string, fn: Listener): () => void {
    const key = `thumb:${id}`;
    const set = this.watchers.get(key) ?? new Set();
    set.add(fn);
    this.watchers.set(key, set);
    return () => {
      set.delete(fn);
      this.queue.cancel(id);
    };
  }

  /** The 2048 px copy for the viewer: the showcase's, a recent one, or a fresh one. Null when not reachable.
   *  `fresh` drops the saved copy first, for one the system purged or that will not draw. */
  async display(id: string, fresh = false): Promise<string | null> {
    if (fresh) for (const kind of ["phone", "view"] as const) await forgetMedia(this.d, kind, id);
    for (const kind of ["phone", "view"] as const) {
      const have = await cached(this.d, kind, id);
      if (have) {
        void touch(this.d, kind, id);
        return have;
      }
    }
    if (!this.hasHub() || !(await this.allowed())) return null;
    try {
      return await fetchMedia(this.d, "view", id);
    } catch {
      return null;
    }
  }

  /**
   * The hub's square cut of a featured photo (1024 px, the user's crop), kept in the showcase.
   * Null when it is not saved and cannot be fetched now: the caller shows the cropped thumbnail.
   * Four at a time, so a fast scroll through a long list does not flood the hub.
   */
  async square(kind: SquareKind, owner: string, photoId: string, crop: Crop | null): Promise<string | null> {
    const id = squareId(kind, owner, photoId, crop);
    const have = await cached(this.d, "phone", id);
    if (have) return have;
    if (!this.hasHub()) return null;
    const pending = this.squares.get(id);
    if (pending) return pending;
    const job = (async () => {
      if (!(await this.allowed())) return null;
      if (this.squareSlots === 0) await new Promise<void>((resolve) => this.squareWaiting.push(resolve));
      this.squareSlots--;
      try {
        const path = await fetchMedia(this.d, "phone", id);
        await dropStaleSquares(this.d, kind, owner, id);
        return path;
      } catch {
        return null;
      } finally {
        this.squareSlots++;
        this.squareWaiting.shift()?.();
      }
    })().finally(() => this.squares.delete(id));
    this.squares.set(id, job);
    return job;
  }

  /** Whether the display copy is already on the phone (a full-screen open will not need the network). */
  hasDisplay = async (id: string): Promise<boolean> =>
    !!(await cached(this.d, "phone", id)) || !!(await cached(this.d, "view", id));

  /** View full size: streamed from the hub, kept an hour. Never kept in the showcase. */
  full(id: string): Promise<FullResult> {
    if (!this.hasHub()) return Promise.resolve({ ok: false, reason: "offline" });
    return fetchFull(this.d, id);
  }

  /** Downloads the showcase: Favourites and cover photos not yet saved. One run at a time; resumes where it stopped. */
  async fillShowcase(onProgress?: (left: number) => void): Promise<void> {
    if (this.running || !this.hasHub()) return;
    this.running = true;
    try {
      const favourites = await favouritePhotoIds(this.d.db);
      const { ids } = await showcaseMissing(this.d, favourites);
      for (let i = 0; i < ids.length; i++) {
        if (!this.hasHub() || !(await this.allowed())) break;
        onProgress?.(ids.length - i);
        await settled();
        await fetchMedia(this.d, "phone", ids[i]).catch(() => undefined);
      }
      // The card squares of photographed species, so the Collection stays sharp offline.
      const cards = await this.d.db.all<{
        scientific_name: string;
        cover: string;
        crop_x: number | null;
        crop_y: number | null;
        crop_size: number | null;
      }>(
        `SELECT scientific_name, cover, crop_x, crop_y, crop_size FROM (${SPECIES_SQL}) WHERE cover IS NOT NULL AND photos > 0`,
      );
      for (const c of cards) {
        if (!this.hasHub()) break;
        await settled();
        await this.square(
          "species",
          referenceId(c.scientific_name).slice(4),
          c.cover,
          toCrop(c.crop_x, c.crop_y, c.crop_size),
        );
      }
      onProgress?.(0);
    } finally {
      this.running = false;
    }
  }

  async clear(kind: "thumbs" | "showcase"): Promise<void> {
    if (kind === "showcase") await clearKind(this.d, "phone");
    else {
      await clearKind(this.d, "thumb");
      await clearKind(this.d, "view");
      for (const k of [...this.known.keys()]) if (k.startsWith("thumb:")) this.known.delete(k);
    }
  }

  /** How many showcase photos are still to be saved, and how many it holds in all. */
  async showcaseStatus(): Promise<{ missing: number; total: number }> {
    const { ids, total } = await showcaseMissing(this.d, await favouritePhotoIds(this.d.db));
    return { missing: ids.length, total };
  }

  trim = (): Promise<number> => enforceThumbCap(this.d);

  get db(): Db {
    return this.d.db;
  }
}
