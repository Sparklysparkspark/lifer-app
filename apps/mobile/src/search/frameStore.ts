// What search reads per photo besides its vector, pulled in pages from /companion/v1/model/frames:
// the detector's subject box, the photo's shape and light stats, whether its time had a zone, and
// the background vector ("tree in the background"), kept in capture_backgrounds like the photo
// vectors. Same paging, cursor and model-version rules as vectorStore.ts.
import type { LightStats } from "@lifer/shared";
import type { Db } from "../store/db";
import { getMeta, setMeta } from "../store/meta";
import { inBatches, settled } from "../sync/yield";
import { fromBase64, VECTOR_BYTES } from "./vectorStore";

const KEY = "smart.frames";
const PAGE = 200;

export interface FramePage {
  imageModelVersion: string;
  items: {
    id: string;
    updatedAt: string;
    box: number[] | null;
    boxUnsure: boolean;
    aspect: number;
    light: LightStats | null;
    takenAtZoned: boolean | null;
    background: string | null;
  }[];
  removed: { id: string; at: string }[];
  last: { since: string; after: string } | null;
  next: { since: string; after: string } | null;
}

export interface FrameState {
  imageModelVersion: string;
  cursor: { since: string; after: string } | null;
  complete: boolean;
}

export const loadFrameState = (db: Db): Promise<FrameState | null> => getMeta<FrameState>(db, KEY);

export async function clearFrames(db: Db): Promise<void> {
  await db.tx(async () => {
    await db.run("DELETE FROM capture_frames");
    await db.run("DELETE FROM capture_backgrounds");
    await db.run("DELETE FROM meta WHERE key = ?", [KEY]);
  });
}

/** Stores a page 50 photos at a time: frames and backgrounds replaced, a missing background dropped, removed captures deleted. */
export async function applyFramePage(db: Db, page: FramePage): Promise<void> {
  await inBatches(page.items, 50, (batch) =>
    db.tx(async () => {
      await db.run(
        `INSERT OR REPLACE INTO capture_frames (capture_id, box, unsure, aspect, light, zoned)
         VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?)").join(",")}`,
        batch.flatMap((i) => [
          i.id,
          i.box ? JSON.stringify(i.box) : null,
          i.boxUnsure ? 1 : 0,
          i.aspect,
          i.light ? JSON.stringify(i.light) : null,
          i.takenAtZoned === null ? null : i.takenAtZoned ? 1 : 0,
        ]),
      );
      // A vector of the wrong size is skipped, like the photo vectors.
      const have = batch
        .map((i) => ({ id: i.id, vec: i.background ? fromBase64(i.background) : null }))
        .filter((i): i is { id: string; vec: Uint8Array } => i.vec?.length === VECTOR_BYTES);
      const keep = new Set(have.map((h) => h.id));
      for (const i of batch)
        if (!keep.has(i.id)) await db.run("DELETE FROM capture_backgrounds WHERE capture_id = ?", [i.id]);
      if (have.length > 0)
        await db.run(
          `INSERT OR REPLACE INTO capture_backgrounds (capture_id, vec) VALUES ${have.map(() => "(?, ?)").join(",")}`,
          have.flatMap((h) => [h.id, h.vec]),
        );
    }),
  );
  await inBatches(page.removed, 200, (batch) =>
    db.tx(async () => {
      for (const r of batch) {
        await db.run("DELETE FROM capture_frames WHERE capture_id = ?", [r.id]);
        await db.run("DELETE FROM capture_backgrounds WHERE capture_id = ?", [r.id]);
      }
    }),
  );
}

export interface FrameSyncDeps {
  db: Db;
  api: { get<T>(path: string, timeoutMs?: number): Promise<T> };
  allowed: () => Promise<boolean>;
  onProgress?: (pulled: number) => void;
}

/** Pulls the frames feed from where it stopped; a different image model on the hub starts it again. */
export async function syncFrames(d: FrameSyncDeps): Promise<{ complete: boolean; changed: number }> {
  let state = await loadFrameState(d.db);
  let changed = 0;
  for (;;) {
    if (!(await d.allowed())) return { complete: false, changed };
    await settled();
    const q = state?.cursor ? `since=${encodeURIComponent(state.cursor.since)}&after=${state.cursor.after}&` : "";
    const page = await d.api.get<FramePage>(`/companion/v1/model/frames?${q}limit=${PAGE}&background=1`, 60_000);
    if (state && state.imageModelVersion !== page.imageModelVersion) {
      await clearFrames(d.db);
      state = null;
      changed++;
      continue;
    }
    const next: FrameState = {
      imageModelVersion: page.imageModelVersion,
      cursor: page.last ?? state?.cursor ?? null,
      complete: !page.next,
    };
    await applyFramePage(d.db, page);
    await setMeta(d.db, KEY, next);
    state = next;
    changed += page.items.length + page.removed.length;
    d.onProgress?.(changed);
    if (!page.next) return { complete: true, changed };
  }
}
