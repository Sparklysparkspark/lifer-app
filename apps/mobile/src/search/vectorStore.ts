// The hub's photo vectors on the phone: one 1,536 byte blob per capture in SQLite, pulled in pages
// from /companion/v1/model/vectors, and a flat in-memory index of them for ranking. 60,000 photos
// are about 92 MB, held as float16 and widened one vector at a time.
import type { Db } from "../store/db";
import { getMeta, setMeta } from "../store/meta";
import { HubError } from "../sync/hubApi";
import { inBatches, settled, yieldNow } from "../sync/yield";

export const VECTOR_DIM = 768;
export const VECTOR_BYTES = VECTOR_DIM * 2;
const BYTES = VECTOR_BYTES;
/** The two tables of float16 vectors: the whole photo, and what is behind the animal. */
export type VectorTable = "capture_vectors" | "capture_backgrounds";
const KEY = "smart.vectors";
/** Photos per request: a smaller page is a smaller JSON.parse in one go. */
const PAGE = 200;

export interface VectorPage {
  imageModelVersion: string;
  dimension: number;
  items: { id: string; updatedAt: string; vector: string }[];
  removed: { id: string; at: string }[];
  last: { since: string; after: string } | null;
  next: { since: string; after: string } | null;
}

/** Where the vector feed stands: the hub's image model, the place in the feed, and whether every photo has been pulled. */
export interface VectorState {
  imageModelVersion: string;
  cursor: { since: string; after: string } | null;
  complete: boolean;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Uint8Array(128).fill(255);
for (let i = 0; i < 64; i++) B64_INDEX[B64.charCodeAt(i)] = i;

/** Base64 to bytes without Buffer or atob, which Hermes may lack. */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_INDEX[clean.charCodeAt(i)];
    if (v === 255) throw new Error("bad base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 255;
    }
  }
  return out;
}

/** Every float16 bit pattern as a float32, built once. */
let HALF: Float32Array | null = null;
function halfTable(): Float32Array {
  if (HALF) return HALF;
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 31;
    const m = h & 1023;
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return (HALF = t);
}

export const loadVectorState = (db: Db): Promise<VectorState | null> => getMeta<VectorState>(db, KEY);

export async function clearVectors(db: Db): Promise<void> {
  await db.tx(async () => {
    await db.run("DELETE FROM capture_vectors");
    await db.run("DELETE FROM meta WHERE key = ?", [KEY]);
  });
}

export const vectorCount = async (db: Db, table: VectorTable = "capture_vectors"): Promise<number> =>
  Number((await db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n ?? 0);

/**
 * Stores a page: new and changed vectors in multi-row inserts, removed captures dropped. A vector of the
 * wrong size is skipped. Decoding and writing go 50 at a time in short transactions, so the screen keeps its turns.
 */
export async function applyVectorPage(db: Db, page: VectorPage): Promise<void> {
  await inBatches(page.items, 50, async (batch) => {
    const chunk = batch.map((i) => ({ id: i.id, vec: fromBase64(i.vector) })).filter((i) => i.vec.length === BYTES);
    if (chunk.length === 0) return;
    await db.tx(() =>
      db.run(
        `INSERT OR REPLACE INTO capture_vectors (capture_id, vec) VALUES ${chunk.map(() => "(?, ?)").join(",")}`,
        chunk.flatMap((c) => [c.id, c.vec]),
      ),
    );
  });
  await inBatches(page.removed, 200, (batch) =>
    db.tx(async () => {
      for (const r of batch) await db.run("DELETE FROM capture_vectors WHERE capture_id = ?", [r.id]);
    }),
  );
}

export interface VectorSyncDeps {
  db: Db;
  api: { get<T>(path: string, timeoutMs?: number): Promise<T> };
  /** False on a metered connection with Wi-Fi only on: checked between pages. */
  allowed: () => Promise<boolean>;
  onProgress?: (pulled: number) => void;
}

/**
 * Pulls the vector feed from where it stopped. A different image model on the hub clears every
 * stored vector and starts again. Resolves with whether the feed is complete; throws like the hub client does.
 */
export async function syncVectors(d: VectorSyncDeps): Promise<{ complete: boolean; changed: number }> {
  let state = await loadVectorState(d.db);
  let changed = 0;
  for (;;) {
    if (!(await d.allowed())) return { complete: false, changed };
    await settled();
    const q = state?.cursor
      ? `?since=${encodeURIComponent(state.cursor.since)}&after=${state.cursor.after}&limit=${PAGE}`
      : `?limit=${PAGE}`;
    const page = await d.api.get<VectorPage>(`/companion/v1/model/vectors${q}`, 60_000);
    if (page.dimension !== VECTOR_DIM) throw new HubError(422);
    if (state && state.imageModelVersion !== page.imageModelVersion) {
      await clearVectors(d.db);
      state = null;
      changed++;
      continue;
    }
    const next: VectorState = {
      imageModelVersion: page.imageModelVersion,
      cursor: page.last ?? state?.cursor ?? null,
      complete: !page.next,
    };
    await applyVectorPage(d.db, page);
    // Stored first, cursor after: a run stopped halfway repeats the page, and the inserts replace.
    await setMeta(d.db, KEY, next);
    state = next;
    changed += page.items.length + page.removed.length;
    d.onProgress?.(changed);
    if (!page.next) return { complete: true, changed };
  }
}

/** All vectors flat in memory, for ranking. */
export class VectorIndex {
  private constructor(
    private readonly slots: Map<string, number>,
    private readonly data: Uint8Array,
  ) {}

  static async load(db: Db, table: VectorTable = "capture_vectors"): Promise<VectorIndex> {
    const count = await vectorCount(db, table);
    const data = new Uint8Array(count * BYTES);
    const slots = new Map<string, number>();
    let after = "";
    while (slots.size < count) {
      const rows = await db.all<{ capture_id: string; vec: Uint8Array }>(
        `SELECT capture_id, vec FROM ${table} WHERE capture_id > ? ORDER BY capture_id LIMIT 500`,
        [after],
      );
      if (rows.length === 0) break;
      for (const r of rows) {
        const slot = slots.size;
        if (slot >= count || r.vec.length !== BYTES) continue;
        data.set(r.vec, slot * BYTES);
        slots.set(r.capture_id, slot);
      }
      after = rows[rows.length - 1].capture_id;
      await yieldNow();
    }
    return new VectorIndex(slots, data);
  }

  get size(): number {
    return this.slots.size;
  }

  /** A shared scratch array, valid until the next read: callers use it at once. Undefined for a photo with no vector. */
  private scratch = new Float32Array(VECTOR_DIM);
  get(id: string): Float32Array | undefined {
    const slot = this.slots.get(id);
    if (slot === undefined) return undefined;
    const half = halfTable();
    const at = slot * BYTES;
    for (let i = 0; i < VECTOR_DIM; i++)
      this.scratch[i] = half[this.data[at + 2 * i] | (this.data[at + 2 * i + 1] << 8)];
    return this.scratch;
  }
}
