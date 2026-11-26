// The desktop side of albums, trips and their membership (library.ts has the protocol): taking
// the server's copies into this install, and pushing what was made or changed here. A pull never
// overwrites a row with an edit not pushed yet; the push settles those with the server's
// version check, and a conflict takes the server's copy at once.
import type { Pool, PoolClient } from "pg";
import type { TSchema } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";
import { parseRemoteJson } from "../offlinePacks/schemas.js";
import { asSyncApply, isoStamp } from "./changes.js";
import {
  ALBUM_FIELDS,
  AlbumPageSchema,
  fieldColumns,
  fieldParam,
  fieldParams,
  fieldValues,
  FIRST_LIBRARY_CURSOR,
  HiddenTermPageSchema,
  KeptPageSchema,
  MemberPageSchema,
  SPOT_FIELDS,
  SpotPageSchema,
  TRIP_FIELDS,
  TripPageSchema,
  type AlbumChange,
  type LibraryCursor,
  type LibraryReply,
  type PushedMember,
  type RowOutcome,
  type SpotChange,
  type TripChange,
} from "./library.js";
import { assertStillLinked, serverFetch, type LinkedServer } from "./serverLink.js";

type Db = Pick<Pool | PoolClient, "query">;
type RowsName = "albums" | "trips" | "saved_spots";
type RowChange = AlbumChange | TripChange | SpotChange;
/** The push body and reply key for each table. */
const BODY_KEY = { albums: "albums", trips: "trips", saved_spots: "savedSpots" } as const;
type MembersName = "album_captures" | "album_exclusions";

const PAGE = 200;
const BATCH = 500;
const CURSOR_PREFIX = "mirror_cursor_";
const FEEDS = {
  trips: ["/sync/trips", TripPageSchema],
  albums: ["/sync/albums", AlbumPageSchema],
  saved_spots: ["/sync/saved-spots", SpotPageSchema],
  album_captures: ["/sync/album-captures", MemberPageSchema],
  album_exclusions: ["/sync/album-exclusions", MemberPageSchema],
  species_split_kept: ["/sync/species-split-kept", KeptPageSchema],
  smart_tag_hidden_terms: ["/sync/smart-tag-hidden", HiddenTermPageSchema],
} as const satisfies Record<
  RowsName | MembersName | "species_split_kept" | "smart_tag_hidden_terms",
  readonly [string, TSchema]
>;
type FeedName = keyof typeof FEEDS;

const fieldsOf = (name: RowsName) => ({ albums: ALBUM_FIELDS, trips: TRIP_FIELDS, saved_spots: SPOT_FIELDS })[name];
/** Not an edit waiting to be pushed. */
const SETTLED = (t: string) => `${t}.pushed_at IS NOT NULL AND ${t}.updated_at <= ${t}.pushed_at`;
const DUE = (t: string) => `(${t}.pushed_at IS NULL OR ${t}.updated_at > ${t}.pushed_at)`;

export interface LibraryPull {
  applied: number;
  removed: number;
}

/** Writes the server's albums or trips here. `force` also replaces rows with an edit not pushed
 *  (a conflict the server won). Returns how many were written. */
export async function applyRows(
  db: Db,
  userId: string,
  name: RowsName,
  items: RowChange[],
  force = false,
): Promise<number> {
  const fields = fieldsOf(name);
  // $1 user, $2 id, $3 the server's version; the fields follow.
  const params = fields.map((f, i) => fieldParam(f, i + 4));
  const sets = fields.map((f, i) => `${f.column} = ${params[i]}`).join(", ");
  let written = 0;
  for (const item of items) {
    const res = await db.query(
      `INSERT INTO ${name} (user_id, id, ${fields.map((f) => f.column).join(", ")}, pushed_at, remote_updated_at)
       SELECT $1::uuid, $2::uuid, ${params.join(", ")}, now(), $3::timestamptz
       ON CONFLICT (id) DO UPDATE SET ${sets}, pushed_at = now(), remote_updated_at = $3::timestamptz
         WHERE ${name}.user_id = $1 ${force ? "" : `AND ${SETTLED(name)}`}`,
      [userId, item.id, item.updatedAt, ...fieldParams(fields, item)],
    );
    written += res.rowCount ?? 0;
  }
  return written;
}

/** Adds the server's membership rows for captures this install has (by its own id or the
 *  server's). Returns how many were new here. */
export async function applyMembers(
  db: Db,
  userId: string,
  table: MembersName,
  rows: { albumId: string; captureId: string }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await db.query(
    `INSERT INTO ${table} (album_id, capture_id, pushed_at)
     SELECT DISTINCT a.id, c.id, now() FROM unnest($2::uuid[], $3::uuid[]) AS v(album_id, capture_id)
     JOIN albums a ON a.id = v.album_id AND a.user_id = $1
     JOIN captures_all c ON (c.id = v.capture_id OR c.remote_id = v.capture_id) AND c.user_id = $1
     ON CONFLICT (album_id, capture_id) DO UPDATE SET pushed_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [userId, rows.map((r) => r.albumId), rows.map((r) => r.captureId)],
  );
  return res.rows.filter((r) => r.inserted).length;
}

/** Marks the server's kept-after-split photos that this install has. Returns how many were new. */
export async function applyKept(db: Db, userId: string, captureIds: string[]): Promise<number> {
  if (captureIds.length === 0) return 0;
  const res = await db.query(
    `INSERT INTO species_split_kept (capture_id, pushed_at)
     SELECT DISTINCT c.id, now() FROM captures_all c
     WHERE (c.id = ANY($2::uuid[]) OR c.remote_id = ANY($2::uuid[])) AND c.user_id = $1
     ON CONFLICT (capture_id) DO UPDATE SET pushed_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [userId, captureIds],
  );
  return res.rows.filter((r) => r.inserted).length;
}

/** Hides the server's hidden smart tag terms here. Returns how many were new. */
export async function applyHidden(db: Db, userId: string, termIds: string[]): Promise<number> {
  if (termIds.length === 0) return 0;
  const res = await db.query(
    `INSERT INTO smart_tag_hidden_terms (user_id, term_id, pushed_at) SELECT $1, unnest($2::text[]), now()
     ON CONFLICT (user_id, term_id) DO UPDATE SET pushed_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [userId, termIds],
  );
  return res.rows.filter((r) => r.inserted).length;
}

/** Removes what the server deleted, leaving rows with an edit not pushed yet. */
async function applyRemovals(db: Db, userId: string, name: FeedName, refs: string[]): Promise<number> {
  if (refs.length === 0) return 0;
  if (name === "smart_tag_hidden_terms") {
    const res = await db.query(
      `DELETE FROM smart_tag_hidden_terms h WHERE h.user_id = $1 AND h.term_id = ANY($2::text[]) AND ${SETTLED("h")}`,
      [userId, refs],
    );
    return res.rowCount ?? 0;
  }
  if (name === "species_split_kept") {
    const res = await db.query(
      `DELETE FROM species_split_kept k USING captures_all c
       WHERE c.id = k.capture_id AND c.user_id = $1 AND (c.id = ANY($2::uuid[]) OR c.remote_id = ANY($2::uuid[]))
         AND ${SETTLED("k")}`,
      [userId, refs],
    );
    return res.rowCount ?? 0;
  }
  if (name !== "album_captures" && name !== "album_exclusions") {
    const res = await db.query(`DELETE FROM ${name} WHERE user_id = $1 AND id = ANY($2::uuid[]) AND ${SETTLED(name)}`, [
      userId,
      refs,
    ]);
    return res.rowCount ?? 0;
  }
  const pairs = refs.map((r) => r.split(":"));
  const res = await db.query(
    `DELETE FROM ${name} m USING unnest($2::uuid[], $3::uuid[]) AS v(album_id, capture_id), albums a, captures_all c
     WHERE a.id = m.album_id AND a.user_id = $1 AND m.album_id = v.album_id AND c.id = m.capture_id
       AND (c.id = v.capture_id OR c.remote_id = v.capture_id) AND ${SETTLED("m")}`,
    [userId, pairs.map((p) => p[0]), pairs.map((p) => p[1])],
  );
  return res.rowCount ?? 0;
}

interface StoredCursor extends LibraryCursor {
  instanceId: string;
}

/** Pulls one feed to its end, a page per transaction, saving the cursor after each. */
async function pullFeed(server: LinkedServer, userId: string, name: FeedName): Promise<LibraryPull> {
  const [url, schema] = FEEDS[name];
  const key = CURSOR_PREFIX + name;
  const saved = await getInstallSetting<StoredCursor>(pool, key);
  let position: LibraryCursor = saved?.instanceId === server.instanceId ? saved : FIRST_LIBRARY_CURSOR;
  const totals: LibraryPull = { applied: 0, removed: 0 };
  for (;;) {
    assertStillLinked(server);
    const res = await serverFetch(
      server,
      `${url}?since=${encodeURIComponent(position.since)}&after=${encodeURIComponent(position.after)}&limit=${PAGE}`,
    );
    if (!res.ok) throw new Error(`The server's ${name.replace("_", " ")} list answered ${res.status}`);
    const page = parseRemoteJson(schema, await res.json(), `server's ${name} list`) as unknown as {
      items: unknown[];
      purged: { ref: string }[];
      last: LibraryCursor | null;
      next: LibraryCursor | null;
    };
    if (!page.last) break;
    await withTransaction(async (client) => {
      await asSyncApply(client);
      totals.removed += await applyRemovals(
        client,
        userId,
        name,
        page.purged.map((p) => p.ref),
      );
      if (name === "smart_tag_hidden_terms")
        totals.applied += await applyHidden(
          client,
          userId,
          (page.items as { termId: string }[]).map((h) => h.termId),
        );
      else if (name === "species_split_kept")
        totals.applied += await applyKept(
          client,
          userId,
          (page.items as { captureId: string }[]).map((k) => k.captureId),
        );
      else if (name !== "album_captures" && name !== "album_exclusions")
        totals.applied += await applyRows(client, userId, name, page.items as RowChange[]);
      else totals.applied += await applyMembers(client, userId, name, page.items as PushedMember[]);
    });
    position = page.last;
    await setInstallSetting(pool, key, { ...position, instanceId: server.instanceId } satisfies StoredCursor);
    if (!page.next) break;
  }
  return totals;
}

/** Trips and albums first: captures and membership refer to them. */
export async function pullLibraryRows(server: LinkedServer, userId: string): Promise<LibraryPull> {
  const trips = await pullFeed(server, userId, "trips");
  const albums = await pullFeed(server, userId, "albums");
  const spots = await pullFeed(server, userId, "saved_spots");
  return {
    applied: trips.applied + albums.applied + spots.applied,
    removed: trips.removed + albums.removed + spots.removed,
  };
}

/** Membership and species corrections after the captures they name are here. */
export async function pullLibraryMembers(server: LinkedServer, userId: string): Promise<LibraryPull> {
  const a = await pullFeed(server, userId, "album_captures");
  const b = await pullFeed(server, userId, "album_exclusions");
  const k = await pullFeed(server, userId, "species_split_kept");
  const h = await pullFeed(server, userId, "smart_tag_hidden_terms");
  return {
    applied: a.applied + b.applied + k.applied + h.applied,
    removed: a.removed + b.removed + k.removed + h.removed,
  };
}

/** Makes the next pull of every library feed start from the beginning. */
export const forgetLibraryCursors = (db: Db) =>
  db.query(`DELETE FROM install_settings WHERE key LIKE '${CURSOR_PREFIX}%'`);

/** Everything here is due for a push to a server that has none of it. */
export async function forgetLibraryPushes(db: Db, userId: string): Promise<void> {
  await db.query(`UPDATE albums SET pushed_at = NULL, remote_updated_at = NULL WHERE user_id = $1`, [userId]);
  await db.query(`UPDATE trips SET pushed_at = NULL, remote_updated_at = NULL WHERE user_id = $1`, [userId]);
  await db.query(`UPDATE saved_spots SET pushed_at = NULL, remote_updated_at = NULL WHERE user_id = $1`, [userId]);
  for (const t of ["album_captures", "album_exclusions"])
    await db.query(`UPDATE ${t} m SET pushed_at = NULL FROM albums a WHERE a.id = m.album_id AND a.user_id = $1`, [
      userId,
    ]);
  await db.query(
    `UPDATE species_split_kept k SET pushed_at = NULL FROM captures_all c WHERE c.id = k.capture_id AND c.user_id = $1`,
    [userId],
  );
  await db.query(`UPDATE smart_tag_hidden_terms SET pushed_at = NULL WHERE user_id = $1`, [userId]);
  await forgetLibraryCursors(db);
}

// --- Push ---

/** What goes to the server in one push request. */
export interface LibraryBody {
  albums?: unknown[];
  trips?: unknown[];
  savedSpots?: unknown[];
  albumCaptures?: PushedMember[];
  albumExclusions?: PushedMember[];
  speciesSplitKept?: string[];
  smartTagHidden?: string[];
  deleted?: {
    albums?: { id: string; baseUpdatedAt: string | null }[];
    trips?: { id: string; baseUpdatedAt: string | null }[];
    savedSpots?: { id: string; baseUpdatedAt: string | null }[];
    albumCaptures?: PushedMember[];
    albumExclusions?: PushedMember[];
    speciesSplitKept?: string[];
    smartTagHidden?: string[];
  };
}
export type SendLibrary = (body: LibraryBody) => Promise<LibraryReply | undefined>;

interface DueRow {
  item: Record<string, unknown>;
  /** updated_at as read, to the microsecond: an edit made after this stays due. */
  stamp: string;
}

async function dueRows(userId: string, name: RowsName): Promise<DueRow[]> {
  const fields = fieldsOf(name);
  const res = await pool.query(
    `SELECT x.id, ${fieldColumns(fields)}, ${isoStamp("x.remote_updated_at")} AS base, x.updated_at::text AS stamp
     FROM ${name} x WHERE x.user_id = $1 AND ${DUE("x")} ORDER BY x.updated_at, x.id`,
    [userId],
  );
  // A trip's cover capture goes by the server's id for it.
  const covers = name === "trips" ? res.rows.flatMap((r) => (r.cover_capture_id ? [r.cover_capture_id] : [])) : [];
  const remote = new Map(
    covers.length
      ? (
          await pool.query<{ id: string; remote_id: string | null }>(
            `SELECT id, remote_id FROM captures_all WHERE id = ANY($1::uuid[])`,
            [covers],
          )
        ).rows.map((c) => [c.id, c.remote_id ?? c.id])
      : [],
  );
  return res.rows.map((r) => {
    const item: Record<string, unknown> = { id: r.id, ...fieldValues(fields, r), baseUpdatedAt: r.base };
    if (name === "trips" && r.cover_capture_id) item.coverCaptureId = remote.get(r.cover_capture_id) ?? null;
    return { item, stamp: r.stamp };
  });
}

async function markRowPushed(db: Db, name: RowsName, id: string, stamp: string, base: string | null) {
  await db.query(
    `UPDATE ${name} SET pushed_at = $2::timestamptz, remote_updated_at = COALESCE($3::timestamptz, remote_updated_at) WHERE id = $1`,
    [id, stamp, base],
  );
}

/** Settles one album or trip: recorded as pushed, or, when the server's copy changed or is gone,
 *  that copy is taken here now. */
async function settle(userId: string, name: RowsName, o: RowOutcome, row: DueRow): Promise<boolean> {
  const id = row.item.id as string;
  if (o.status === "updated") {
    await markRowPushed(pool, name, id, row.stamp, o.updatedAt);
    return true;
  }
  await withTransaction(async (client) => {
    await asSyncApply(client);
    if (o.current) await applyRows(client, userId, name, [o.current as RowChange], true);
    else await client.query(`DELETE FROM ${name} WHERE id = $1 AND user_id = $2`, [id, userId]);
  });
  return false;
}

/** Sends the albums and trips changed here, before the captures that refer to them. Returns
 *  how many the server took and how many were conflicts. */
export async function pushLibraryRows(
  userId: string,
  send: SendLibrary,
): Promise<{ pushed: number; conflicts: number }> {
  let pushed = 0;
  let conflicts = 0;
  for (const name of ["trips", "saved_spots", "albums"] as const) {
    const due = await dueRows(userId, name);
    for (let i = 0; i < due.length; i += BATCH) {
      const batch = due.slice(i, i + BATCH);
      const reply = await send({ [BODY_KEY[name]]: batch.map((b) => b.item) });
      const outcomes = new Map((reply?.[BODY_KEY[name]] ?? []).map((o) => [o.id, o]));
      for (const row of batch) {
        const o = outcomes.get(row.item.id as string);
        if (!o) continue;
        if (await settle(userId, name, o, row)) pushed++;
        else conflicts++;
      }
    }
  }
  return { pushed, conflicts };
}

interface DueMember extends PushedMember {
  stamp: string;
}

/** Membership rows changed here whose capture the server has. */
async function dueMembers(userId: string, table: MembersName): Promise<DueMember[]> {
  const res = await pool.query(
    `SELECT m.album_id, COALESCE(c.remote_id, c.id) AS capture_id, m.updated_at::text AS stamp
     FROM ${table} m JOIN albums a ON a.id = m.album_id JOIN captures_all c ON c.id = m.capture_id
     WHERE a.user_id = $1 AND ${DUE("m")} AND (c.origin = 'mirror' OR c.pushed_at IS NOT NULL)`,
    [userId],
  );
  return res.rows.map((r) => ({ albumId: r.album_id, captureId: r.capture_id, stamp: r.stamp }));
}

/** Sends album membership and exclusions, after the captures are on the server. */
export async function pushLibraryMembers(userId: string, send: SendLibrary): Promise<number> {
  let sent = 0;
  for (const [table, key] of [
    ["album_captures", "albumCaptures"],
    ["album_exclusions", "albumExclusions"],
  ] as const) {
    const due = await dueMembers(userId, table);
    for (let i = 0; i < due.length; i += BATCH) {
      const batch = due.slice(i, i + BATCH);
      await send({ [key]: batch.map(({ albumId, captureId }) => ({ albumId, captureId })) });
      await pool.query(
        `UPDATE ${table} m SET pushed_at = v.stamp
         FROM unnest($1::uuid[], $2::uuid[], $3::timestamptz[]) AS v(album_id, capture_id, stamp), captures_all c
         WHERE c.id = m.capture_id AND m.album_id = v.album_id AND COALESCE(c.remote_id, c.id) = v.capture_id`,
        [batch.map((b) => b.albumId), batch.map((b) => b.captureId), batch.map((b) => b.stamp)],
      );
      sent += batch.length;
    }
  }
  // Species corrections, by the server's id for the photo.
  const kept = await pool.query<{ capture_id: string; stamp: string }>(
    `SELECT COALESCE(c.remote_id, c.id) AS capture_id, k.updated_at::text AS stamp
     FROM species_split_kept k JOIN captures_all c ON c.id = k.capture_id
     WHERE c.user_id = $1 AND ${DUE("k")} AND (c.origin = 'mirror' OR c.pushed_at IS NOT NULL)`,
    [userId],
  );
  for (let i = 0; i < kept.rows.length; i += BATCH) {
    const batch = kept.rows.slice(i, i + BATCH);
    await send({ speciesSplitKept: batch.map((b) => b.capture_id) });
    await pool.query(
      `UPDATE species_split_kept k SET pushed_at = v.stamp
       FROM unnest($1::uuid[], $2::timestamptz[]) AS v(capture_id, stamp), captures_all c
       WHERE c.id = k.capture_id AND COALESCE(c.remote_id, c.id) = v.capture_id`,
      [batch.map((b) => b.capture_id), batch.map((b) => b.stamp)],
    );
    sent += batch.length;
  }
  const hidden = await pool.query<{ term_id: string; stamp: string }>(
    `SELECT h.term_id, h.updated_at::text AS stamp FROM smart_tag_hidden_terms h WHERE h.user_id = $1 AND ${DUE("h")}`,
    [userId],
  );
  for (let i = 0; i < hidden.rows.length; i += BATCH) {
    const batch = hidden.rows.slice(i, i + BATCH);
    await send({ smartTagHidden: batch.map((b) => b.term_id) });
    await pool.query(
      `UPDATE smart_tag_hidden_terms h SET pushed_at = v.stamp
       FROM unnest($2::text[], $3::timestamptz[]) AS v(term_id, stamp) WHERE h.user_id = $1 AND h.term_id = v.term_id`,
      [userId, batch.map((b) => b.term_id), batch.map((b) => b.stamp)],
    );
    sent += batch.length;
  }
  return sent;
}

const KINDS = [
  "album",
  "trip",
  "saved_spot",
  "album_capture",
  "album_exclusion",
  "species_split_kept",
  "smart_tag_hidden",
] as const;

/** Sends what was deleted here (sync_tombstones, migration 163) and forgets it once the server answers. */
export async function pushLibraryDeletions(userId: string, send: SendLibrary): Promise<number> {
  const res = await pool.query<{ id: string; kind: (typeof KINDS)[number]; ref: string; base: string | null }>(
    `SELECT id, kind, ref, ${isoStamp("base")} AS base FROM sync_tombstones
     WHERE user_id = $1 AND kind = ANY($2::text[]) ORDER BY id`,
    [userId, [...KINDS]],
  );
  const rows = res.rows;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const pair = (ref: string) => {
      const [albumId, captureId] = ref.split(":");
      return { albumId, captureId };
    };
    const versioned = (kind: "album" | "trip" | "saved_spot") =>
      batch.filter((t) => t.kind === kind).map((t) => ({ id: t.ref, baseUpdatedAt: t.base }));
    await send({
      deleted: {
        albums: versioned("album"),
        trips: versioned("trip"),
        savedSpots: versioned("saved_spot"),
        albumCaptures: batch.filter((t) => t.kind === "album_capture").map((t) => pair(t.ref)),
        albumExclusions: batch.filter((t) => t.kind === "album_exclusion").map((t) => pair(t.ref)),
        speciesSplitKept: batch.filter((t) => t.kind === "species_split_kept").map((t) => t.ref),
        smartTagHidden: batch.filter((t) => t.kind === "smart_tag_hidden").map((t) => t.ref),
      },
    });
    await pool.query(`DELETE FROM sync_tombstones WHERE id = ANY($1::bigint[])`, [batch.map((t) => t.id)]);
  }
  return rows.length;
}

/** What's waiting for the server, by what the user sees: albums (with their photos and
 *  exclusions) and trips, deletions included. */
export async function waitingLibrary(userId: string, db: Db = pool): Promise<{ albums: number; trips: number }> {
  const res = await db.query<{ albums: number; trips: number }>(
    `SELECT ((SELECT count(*) FROM albums x WHERE user_id = $1 AND ${DUE("x")})
          + (SELECT count(*) FROM album_captures m JOIN albums a ON a.id = m.album_id WHERE a.user_id = $1 AND ${DUE("m")})
          + (SELECT count(*) FROM album_exclusions m JOIN albums a ON a.id = m.album_id WHERE a.user_id = $1 AND ${DUE("m")})
          + (SELECT count(*) FROM sync_tombstones WHERE user_id = $1 AND kind IN ('album', 'album_capture', 'album_exclusion')))::int AS albums,
            ((SELECT count(*) FROM trips x WHERE user_id = $1 AND ${DUE("x")})
          + (SELECT count(*) FROM sync_tombstones WHERE user_id = $1 AND kind IN ('trip', 'saved_spot'))
          + (SELECT count(*) FROM saved_spots x WHERE user_id = $1 AND ${DUE("x")}))::int AS trips`,
    [userId],
  );
  return res.rows[0] ?? { albums: 0, trips: 0 };
}

/** Albums, trips, saved spots and membership changed or deleted here and not sent yet. */
export async function unpushedLibraryCount(userId: string, db: Db = pool): Promise<number> {
  const { albums, trips } = await waitingLibrary(userId, db);
  return albums + trips;
}
