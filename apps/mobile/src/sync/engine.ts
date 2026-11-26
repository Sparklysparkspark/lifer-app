// Pull deltas, push marks. Every step is small and resumable: cursors move only after a page is
// stored, queued edits stay until the hub confirms them, and a stopped run loses nothing.
import type { Db } from "../store/db";
import { getMeta, setMeta } from "../store/meta";
import {
  applyAlbums,
  applyCaptureChanges,
  applyMembers,
  applySpots,
  applyTrips,
  type AlbumChange,
  type CaptureChange,
  type SpotChange,
  type TripChange,
} from "../store/library";
import { applyHubMark, getMark, isBlank, type Mark } from "../store/marks";
import { HubError, HubUnreachable } from "./hubApi";
import { mirrorRegions } from "./regionMirror";
import { getRegionTree, pullRegionTree } from "./regionTree";
import { pullSearchVocab } from "./searchVocab";
import { inBatches, settled } from "./yield";

export interface SyncApi {
  get<T>(path: string, timeoutMs?: number): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface HubMark {
  scientificName: string;
  state: "collected" | "seen" | null;
  coverPhotoId: string | null;
  firstCollected: string | null;
  bestQuality: number | null;
  cardCropX: number | null;
  cardCropY: number | null;
  cardCropSize: number | null;
  isTarget: boolean;
  needsBetterPhoto?: boolean;
  updatedAt?: string;
}

export interface Preferences {
  nameDisplay: { main: string; also: string[] } | null;
  namingStyles: string[];
  sensitive: { enabled: boolean; added: string[]; removed: string[]; iucnStatuses: string[] };
  geoprivacy: { spotDefault: string };
  regions: { regionId: string | null; name: string; packIds: string[]; speciesCount: number }[];
}

export interface SyncResult {
  /** Whether the hub answered. */
  reached: boolean;
  /** Edits confirmed by the hub. */
  pushed: number;
  /** Edits replaced by a newer copy from the hub. */
  replaced: number;
  /** Captures added or changed. */
  pulled: number;
  /** The hub refused the device key: pair again. */
  unauthorized: boolean;
}

export interface SyncDeps {
  db: Db;
  api: SyncApi;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  onProgress?: (pulledSoFar: number) => void;
}

/** Wait before an edit that failed to send is tried again: 5 s doubling to 15 min. */
export const backoffMs = (attempts: number): number => Math.min(15 * 60_000, 5000 * 2 ** Math.min(attempts, 10));

const rank = (s: Mark["state"]): number => (s === "collected" ? 2 : s === "seen" ? 1 : 0);

/**
 * The hub changed a mark since the version this phone saw. Newest wins, so the hub's copy is taken.
 * The one exception is a mark the hub never showed this phone (an on-its-own list meeting a library
 * for the first time): there nothing is lost, so the stronger state and any target flag are kept.
 */
export function resolveConflict(local: Mark, hub: HubMark): { mark: Mark; requeue: boolean } {
  const theirs: Mark = { ...hub, needsBetterPhoto: hub.needsBetterPhoto ?? null, hubVersion: hub.updatedAt ?? null };
  if (local.hubVersion !== null) return { mark: theirs, requeue: false };
  const state = rank(local.state) > rank(hub.state) ? local.state : hub.state;
  const isTarget = local.isTarget || hub.isTarget;
  return { mark: { ...theirs, state, isTarget }, requeue: state !== hub.state || isTarget !== hub.isTarget };
}

async function withRetry<T>(fn: () => Promise<T>, sleep: SyncDeps["sleep"]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const transient = e instanceof HubUnreachable || (e instanceof HubError && (e.status >= 500 || e.status === 429));
      if (!transient || attempt >= 2) throw e;
      await sleep(500 * 3 ** attempt);
    }
  }
}

async function pushMarks(d: SyncDeps, result: SyncResult): Promise<boolean> {
  const at = d.now().toISOString();
  const due = await d.db.all<{ ref: string }>(
    "SELECT ref FROM outbox WHERE kind = 'mark' AND (next_try_at IS NULL OR next_try_at <= ?) ORDER BY created_at LIMIT 500",
    [at],
  );
  const marks = (await Promise.all(due.map((r) => getMark(d.db, r.ref)))).filter((m): m is Mark => !!m);
  const gone = due.filter((r) => !marks.some((m) => m.scientificName === r.ref));
  for (const r of gone) await d.db.run("DELETE FROM outbox WHERE kind = 'mark' AND ref = ?", [r.ref]);
  if (!marks.length) return false;

  let reply: { applied: Record<string, string>; conflicts: HubMark[] };
  try {
    reply = await withRetry(
      () =>
        d.api.post("/sync/user-species", {
          items: marks.map((m) => ({
            scientificName: m.scientificName,
            state: m.state,
            coverPhotoId: m.coverPhotoId,
            firstCollected: m.firstCollected,
            bestQuality: m.bestQuality,
            cardCropX: m.cardCropX,
            cardCropY: m.cardCropY,
            cardCropSize: m.cardCropSize,
            isTarget: m.isTarget,
            // Left out until the hub has sent it, so the hub keeps its own.
            needsBetterPhoto: m.needsBetterPhoto ?? undefined,
            baseUpdatedAt: m.hubVersion,
          })),
        }),
      d.sleep,
    );
  } catch (e) {
    for (const m of marks) {
      const row = await d.db.get<{ attempts: number }>("SELECT attempts FROM outbox WHERE kind = 'mark' AND ref = ?", [
        m.scientificName,
      ]);
      const n = (row?.attempts ?? 0) + 1;
      await d.db.run(
        "UPDATE outbox SET attempts = ?, next_try_at = ? WHERE kind = 'mark' AND ref = ? AND created_at <= ?",
        [n, new Date(d.now().getTime() + backoffMs(n)).toISOString(), m.scientificName, at],
      );
    }
    throw e;
  }

  result.reached = true;
  let requeued = false;
  await d.db.tx(async () => {
    const conflicts = new Map(reply.conflicts.map((c) => [c.scientificName, c]));
    for (const m of marks) {
      const name = m.scientificName;
      const hubCopy = conflicts.get(name);
      // Edited again while this was in flight: that edit is newest, so it stays queued, based on the hub's latest.
      const newer = await d.db.get("SELECT 1 FROM outbox WHERE kind = 'mark' AND ref = ? AND created_at > ?", [
        name,
        at,
      ]);
      if (newer) {
        const version = hubCopy ? (hubCopy.updatedAt ?? null) : reply.applied[name];
        if (version !== undefined)
          await d.db.run("UPDATE marks SET hub_version = ? WHERE scientific_name = ?", [version, name]);
        if (!hubCopy && version) result.pushed++;
        continue;
      }
      if (hubCopy) {
        const { mark, requeue } = resolveConflict(m, hubCopy);
        const { hubVersion, ...rest } = mark;
        await applyHubMark(d.db, { ...rest, updatedAt: hubVersion }, d.now());
        if (requeue) {
          await d.db.run("INSERT OR REPLACE INTO outbox (kind, ref, created_at) VALUES ('mark', ?, ?)", [name, at]);
          requeued = true;
        } else result.replaced++;
        continue;
      }
      const version = reply.applied[name];
      if (version) {
        await d.db.run("UPDATE marks SET hub_version = ? WHERE scientific_name = ?", [version, name]);
        result.pushed++;
      }
      // Not applied and not in conflict: the hub's catalogue lacks the species, so there is nothing to send.
      await d.db.run("DELETE FROM outbox WHERE kind = 'mark' AND ref = ?", [name]);
    }
  });
  return requeued;
}

interface Page<T> {
  items: T[];
  purged: ({ id: string } | { ref: string })[];
  last: { since: string; after: string } | null;
  next: { since: string; after: string } | null;
}

async function pullFeed<T>(
  d: SyncDeps,
  key: string,
  path: string,
  apply: (items: T[], purged: string[]) => Promise<void>,
): Promise<number> {
  let cursor = await getMeta<{ since: string; after: string }>(d.db, `cursor.${key}`);
  let count = 0;
  for (;;) {
    const q = cursor
      ? `?since=${encodeURIComponent(cursor.since)}${cursor.after ? `&after=${encodeURIComponent(cursor.after)}` : ""}&limit=500`
      : "?limit=500";
    const page = await withRetry(() => d.api.get<Page<T>>(`${path}${q}`), d.sleep);
    await settled();
    // Short transactions, so a screen's own queries never wait behind a long write. Every apply is an
    // upsert, so a run stopped halfway just repeats the page: the cursor moves only once it is stored.
    await inBatches(page.items, 100, (b) => d.db.tx(() => apply(b, [])));
    await inBatches(
      page.purged.map((p) => ("id" in p ? p.id : p.ref)),
      200,
      (b) => d.db.tx(() => apply([], b)),
    );
    if (page.last) await setMeta(d.db, `cursor.${key}`, page.last);
    count += page.items.length;
    if (key === "captures") d.onProgress?.(count);
    if (!page.next) return count;
    cursor = page.next;
  }
}

/**
 * A smart album has rules, not member rows: the hub says which photos match (minus its exclusions)
 * and the phone keeps them as the album's members, replaced whole at every sync. The same reply
 * carries every album's cover as the desktop shows it, which can change with no album edit.
 */
async function pullSmartAlbums(d: SyncDeps): Promise<number> {
  const res = await withRetry(
    () =>
      d.api.get<{
        albums?: { id: string; captureIds: string[] }[];
        covers?: { id: string; coverPhotoId: string | null }[];
      }>("/companion/v1/albums/smart", 60_000),
    d.sleep,
  );
  await inBatches(res.covers ?? [], 200, (batch) =>
    d.db.tx(async () => {
      for (const c of batch)
        await d.db.run("UPDATE albums SET hub_cover_photo_id = ? WHERE id = ?", [c.coverPhotoId, c.id]);
    }),
  );
  const albums = res.albums ?? [];
  await inBatches(albums, 1, ([a]) =>
    d.db.tx(async () => {
      await d.db.run("DELETE FROM album_captures WHERE album_id = ?", [a.id]);
      for (let i = 0; i < a.captureIds.length; i += 200) {
        const ids = a.captureIds.slice(i, i + 200);
        await d.db.run(
          `INSERT OR IGNORE INTO album_captures (album_id, capture_id) VALUES ${ids.map(() => "(?, ?)").join(",")}`,
          ids.flatMap((id) => [a.id, id]),
        );
      }
    }),
  );
  return albums.length;
}

async function pullMarks(d: SyncDeps): Promise<void> {
  const { items } = await withRetry(() => d.api.get<{ items: HubMark[] }>("/sync/user-species"), d.sleep);
  await inBatches(items, 100, (batch) =>
    d.db.tx(async () => {
      // Checked inside the transaction, so an edit made while the list downloaded is never overwritten.
      const queued = new Set(
        (await d.db.all<{ ref: string }>("SELECT ref FROM outbox WHERE kind = 'mark'")).map((r) => r.ref),
      );
      for (const hub of batch) {
        if (queued.has(hub.scientificName)) continue;
        const mine = await getMark(d.db, hub.scientificName);
        // A mark stored before the phone kept Needs a better photo is taken again once to learn it.
        const known = mine?.needsBetterPhoto !== null || hub.needsBetterPhoto === undefined;
        if (mine && mine.hubVersion === (hub.updatedAt ?? null) && known) continue;
        if (!mine && isBlank(hub)) continue;
        await applyHubMark(d.db, hub, d.now());
      }
    }),
  );
}

/** Learns common names from the hub's photo list for species no checklist has named, a few pages at most. */
async function fillNames(d: SyncDeps, maxPages = 6): Promise<void> {
  const missing = () =>
    d.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM species WHERE common_name IS NULL
         AND scientific_name IN (SELECT scientific_name FROM captures)`,
    );
  let cursor: string | null = null;
  for (let page = 0; page < maxPages && Number((await missing())?.n) > 0; page++) {
    const res: {
      items: { scientificName: string; commonName: string | null; taxonClass: string | null }[];
      nextCursor: string | null;
    } = await d.api.get(`/gallery?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    await inBatches(res.items, 100, (batch) =>
      d.db.tx(async () => {
        for (const i of batch)
          if (i.commonName)
            await d.db.run(
              "UPDATE species SET common_name = ?, taxon_class = COALESCE(taxon_class, ?) WHERE scientific_name = ? AND common_name IS NULL",
              [i.commonName, i.taxonClass, i.scientificName],
            );
      }),
    );
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
}

/** One full pass: send queued edits, then fetch everything that changed. Never throws for an unreachable hub. */
export async function runSync(d: SyncDeps): Promise<SyncResult> {
  const result: SyncResult = { reached: false, pushed: 0, replaced: 0, pulled: 0, unauthorized: false };
  try {
    for (let pass = 0; pass < 2; pass++) if (!(await pushMarks(d, result))) break;
    const prefs = await withRetry(() => d.api.get<Preferences>("/sync/preferences"), d.sleep);
    await setMeta(d.db, "prefs", prefs);
    result.reached = true;
    // A hub too old for the tree keeps what the phone already has.
    await pullRegionTree(d).catch((e) => {
      if (!(e instanceof HubError) || e.status === 401 || e.status === 403) throw e;
    });
    await mirrorRegions(d, prefs, await getRegionTree(d.db));
    result.pulled = await pullFeed<CaptureChange>(d, "captures", "/sync/changes", (i, p) =>
      applyCaptureChanges(d.db, i, p),
    );
    // A hub too old for one of these feeds still syncs the rest.
    const soft = (p: Promise<number>) =>
      p.catch((e) => {
        if (!(e instanceof HubError) || e.status === 401 || e.status === 403) throw e;
        return 0;
      });
    await soft(pullFeed<AlbumChange>(d, "albums", "/sync/albums", (i, p) => applyAlbums(d.db, i, p)));
    await soft(pullFeed<TripChange>(d, "trips", "/sync/trips", (i, p) => applyTrips(d.db, i, p)));
    await soft(pullFeed<SpotChange>(d, "spots", "/sync/saved-spots", (i, p) => applySpots(d.db, i, p)));
    await soft(
      pullFeed<{ albumId: string; captureId: string }>(d, "members", "/sync/album-captures", (i, p) =>
        applyMembers(d.db, i, p),
      ),
    );
    await soft(pullSearchVocab(d).then(() => 0));
    await soft(pullSmartAlbums(d));
    await pullMarks(d);
    await fillNames(d).catch(() => undefined);
    await setMeta(d.db, "lastSyncAt", d.now().toISOString());
  } catch (e) {
    if (e instanceof HubError && (e.status === 401 || e.status === 403)) {
      result.reached = true;
      result.unauthorized = true;
    } else if (!(e instanceof HubUnreachable) && !(e instanceof HubError)) throw e;
  }
  return result;
}

/** Edits still waiting to reach the hub. */
export const pendingCount = async (db: Db): Promise<number> =>
  Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM outbox"))?.n ?? 0);
