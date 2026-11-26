// Albums, trips and their membership, in the sync protocol (migration 163). Ids are uuids both
// installs share, so there is no remote id. Albums and trips are rows with a version
// (updated_at): a push writes one only if the receiver's row hasn't changed since the version the
// sender last had, else it answers "conflict" with its copy, the same rule as captures. Membership
// rows (album_captures, album_exclusions) are plain sets: adding is idempotent, removing is a
// tombstone, and each travels with the capture's id as the receiver knows it. Cover photos are
// applied only where that photo exists on the receiving side.
import type { Pool, PoolClient } from "pg";
import { Type, type Static, type TSchema } from "typebox";
import { Nullable, Uuid } from "../lib/schema.js";
import { isoStamp } from "./changes.js";

type Db = Pick<Pool | PoolClient, "query">;

const Stamp = Type.String({ format: "date-time" });
const CropSize = Nullable(Type.Number({ minimum: 0, maximum: 100 }));
const Layout = Type.Union([Type.Literal("single"), Type.Literal("quad")]);
const Text = Nullable(Type.String({ maxLength: 20000 }));
// Index-aligned with quadCrops: an unset slot is null, so nulls sit inside the array.
const QuadIds = Nullable(Type.Array(Nullable(Uuid()), { maxItems: 8 }));
const QuadCrops = Nullable(Type.Array(Type.Any(), { maxItems: 8 }));

/** A column both installs send: its row field, SQL type and, where the value must exist on the
 *  receiver, the expression that keeps it only if it does ({} is the parameter). */
export interface Field {
  column: string;
  prop: string;
  type: string;
  read?: string;
  write?: string;
}
const field = (column: string, prop: string, type: string, extra: Partial<Field> = {}): Field => ({
  column,
  prop,
  type,
  ...extra,
});
const NUM = { read: "::float8" };

export const ALBUM_FIELDS: Field[] = [
  field("name", "name", "text"),
  field("description", "description", "text"),
  field("cover_photo_id", "coverPhotoId", "uuid", { write: "(SELECT id FROM photos WHERE id = {}::uuid)" }),
  field("cover_crop_x", "coverCropX", "numeric", NUM),
  field("cover_crop_y", "coverCropY", "numeric", NUM),
  field("cover_crop_size", "coverCropSize", "numeric", NUM),
  field("cover_layout", "coverLayout", "text"),
  field("quad_photo_ids", "quadPhotoIds", "uuid[]"),
  field("quad_crops", "quadCrops", "jsonb"),
  field("rules", "rules", "jsonb"),
];

export const TRIP_FIELDS: Field[] = [
  field("name", "name", "text"),
  field("description", "description", "text"),
  field("source_folder", "sourceFolder", "text"),
  field("destination_folder", "destinationFolder", "text"),
  field("cover_capture_id", "coverCaptureId", "uuid", {
    write: "(SELECT id FROM captures_all WHERE (id = {}::uuid OR remote_id = {}::uuid) AND user_id = $1 LIMIT 1)",
  }),
  field("cover_crop_x", "coverCropX", "numeric", NUM),
  field("cover_crop_y", "coverCropY", "numeric", NUM),
  field("cover_crop_size", "coverCropSize", "numeric", NUM),
  field("cover_layout", "coverLayout", "text"),
  field("quad_photo_ids", "quadPhotoIds", "uuid[]"),
  field("quad_crops", "quadCrops", "jsonb"),
  field("start_date", "startDate", "date", { read: "::text" }),
  field("end_date", "endDate", "date", { read: "::text" }),
  field("region_id", "regionId", "uuid", { write: "(SELECT id FROM regions WHERE id = {}::uuid)" }),
  field("active_override", "activeOverride", "boolean"),
];

export const SPOT_FIELDS: Field[] = [
  field("name", "name", "text"),
  field("lat", "lat", "numeric", NUM),
  field("lon", "lon", "numeric", NUM),
  field("region_id", "regionId", "uuid", { write: "(SELECT id FROM regions WHERE id = {}::uuid)" }),
  field("geoprivacy", "geoprivacy", "text"),
  // An older sender lacks these; the receiver's defaults fill them.
  field("radius_m", "radiusM", "integer", { write: "COALESCE({}::integer, 100)" }),
  field("locality", "locality", "text"),
  field("locality_source", "localitySource", "text"),
  field("notes", "notes", "text"),
  field("origin", "origin", "text", { write: "COALESCE({}::text, 'map')" }),
];

const albumProps = {
  id: Uuid(),
  name: Type.String({ minLength: 1 }),
  description: Text,
  coverPhotoId: Nullable(Uuid()),
  coverCropX: CropSize,
  coverCropY: CropSize,
  coverCropSize: CropSize,
  coverLayout: Layout,
  quadPhotoIds: QuadIds,
  quadCrops: QuadCrops,
  rules: Nullable(Type.Any()),
};
const tripProps = {
  id: Uuid(),
  name: Type.String({ minLength: 1 }),
  description: Text,
  sourceFolder: Type.String({ maxLength: 4096 }),
  destinationFolder: Type.String({ maxLength: 4096 }),
  coverCaptureId: Nullable(Uuid()),
  coverCropX: CropSize,
  coverCropY: CropSize,
  coverCropSize: CropSize,
  coverLayout: Layout,
  quadPhotoIds: QuadIds,
  quadCrops: QuadCrops,
  startDate: Nullable(Type.String({ format: "date" })),
  endDate: Nullable(Type.String({ format: "date" })),
  regionId: Nullable(Uuid()),
  activeOverride: Nullable(Type.Boolean()),
};

export const AlbumChangeSchema = Type.Object({ ...albumProps, updatedAt: Stamp });
export const TripChangeSchema = Type.Object({ ...tripProps, updatedAt: Stamp });
const spotProps = {
  id: Uuid(),
  name: Type.String({ minLength: 1, maxLength: 500 }),
  lat: Type.Number({ minimum: -90, maximum: 90 }),
  lon: Type.Number({ minimum: -180, maximum: 180 }),
  regionId: Nullable(Uuid()),
  geoprivacy: Type.Union([Type.Literal("open"), Type.Literal("obscured"), Type.Literal("private")]),
  radiusM: Type.Optional(Type.Integer({ minimum: 25, maximum: 5000 })),
  locality: Type.Optional(Nullable(Type.String({ maxLength: 300 }))),
  localitySource: Type.Optional(
    Nullable(Type.Union(["gazetteer", "region", "inaturalist", "user"].map((v) => Type.Literal(v)))),
  ),
  notes: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  origin: Type.Optional(Type.Union(["map", "photo", "inaturalist"].map((v) => Type.Literal(v)))),
};
export const SpotChangeSchema = Type.Object({ ...spotProps, updatedAt: Stamp });
export const MemberSchema = Type.Object({ albumId: Uuid(), captureId: Uuid(), updatedAt: Stamp });
/** A photo whose old species the user kept after a split (species_split_kept). */
export const KeptSchema = Type.Object({ captureId: Uuid(), updatedAt: Stamp });
/** A smart tag vocabulary term the user hid for every photo (smart_tag_hidden_terms). */
export const SmartTagTermId = Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9-]+(\\.[a-z0-9-]+)*$" });
export const HiddenTermSchema = Type.Object({ termId: SmartTagTermId, updatedAt: Stamp });
export type AlbumChange = Static<typeof AlbumChangeSchema>;
export type TripChange = Static<typeof TripChangeSchema>;
export type SpotChange = Static<typeof SpotChangeSchema>;
export type MemberChange = Static<typeof MemberSchema>;

/** A pushed album or trip: the fields plus the receiver's version the sender last had. */
// No length cap on sync: a name saved before the 255 limit must still sync; create and rename enforce it.
const PushedName = Type.String({ minLength: 1 });
export const PushedAlbumSchema = Type.Object({ ...albumProps, name: PushedName, baseUpdatedAt: Nullable(Stamp) });
export const PushedTripSchema = Type.Object({ ...tripProps, name: PushedName, baseUpdatedAt: Nullable(Stamp) });
export const PushedSpotSchema = Type.Object({ ...spotProps, baseUpdatedAt: Nullable(Stamp) });
export type PushedSpot = Static<typeof PushedSpotSchema>;
export type PushedAlbum = Static<typeof PushedAlbumSchema>;
export type PushedTrip = Static<typeof PushedTripSchema>;
export const PushedMemberSchema = Type.Object({ albumId: Uuid(), captureId: Uuid() });
export type PushedMember = Static<typeof PushedMemberSchema>;
export const DeletedRowSchema = Type.Object({ id: Uuid(), baseUpdatedAt: Nullable(Stamp) });

const Cursor = Type.Object({ since: Stamp, after: Type.String({ maxLength: 100 }) });
export type LibraryCursor = Static<typeof Cursor>;
export const FIRST_LIBRARY_CURSOR: LibraryCursor = { since: "1970-01-01T00:00:00Z", after: "" };

const pageSchema = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    /** Refs deleted since the cursor (an album or trip id, or "albumId:captureId"). */
    purged: Type.Array(Type.Object({ ref: Type.String({ maxLength: 100 }), deletedAt: Stamp })),
    last: Nullable(Cursor),
    next: Nullable(Cursor),
  });
export const AlbumPageSchema = pageSchema(AlbumChangeSchema);
export const TripPageSchema = pageSchema(TripChangeSchema);
export const MemberPageSchema = pageSchema(MemberSchema);
export const SpotPageSchema = pageSchema(SpotChangeSchema);
export const KeptPageSchema = pageSchema(KeptSchema);
export const HiddenTermPageSchema = pageSchema(HiddenTermSchema);

type Row = Record<string, unknown>;

interface Entity {
  kind:
    "album" | "trip" | "album_capture" | "album_exclusion" | "saved_spot" | "species_split_kept" | "smart_tag_hidden";
  /** FROM clause with the row as x. */
  from: string;
  user: string;
  /** The row's ref as text, unique per user. */
  key: string;
  columns: string;
  map: (r: Row) => unknown;
}

export const fieldColumns = (fields: Field[]) =>
  fields.map((f) => `x.${f.column}${f.read ?? ""} AS ${f.column}`).join(", ");
export const fieldValues = (fields: Field[], r: Row) =>
  Object.fromEntries(fields.map((f) => [f.prop, r[f.column] ?? null]));

// A phone knows captures by the id /sync/changes gives it (this install's own), so its membership
// feeds name captures that way; a linked desktop names them by the server's id (remote_id).
const memberEntity = (kind: "album_capture" | "album_exclusion", table: string, own = false): Entity => ({
  kind,
  from: `${table} x JOIN albums a ON a.id = x.album_id JOIN captures_all c ON c.id = x.capture_id`,
  user: "a.user_id",
  key: own ? "x.album_id || ':' || c.id" : "x.album_id || ':' || COALESCE(c.remote_id, c.id)",
  columns: own ? "x.album_id, c.id AS capture_id" : "x.album_id, COALESCE(c.remote_id, c.id) AS capture_id",
  map: (r) => ({ albumId: r.album_id, captureId: r.capture_id, updatedAt: r.updated_at }),
});

export const ENTITIES = {
  albums: {
    kind: "album",
    from: "albums x",
    user: "x.user_id",
    key: "x.id::text",
    columns: `x.id, ${fieldColumns(ALBUM_FIELDS)}`,
    map: (r) => ({ id: r.id, ...fieldValues(ALBUM_FIELDS, r), updatedAt: r.updated_at }),
  },
  trips: {
    kind: "trip",
    from: "trips x",
    user: "x.user_id",
    key: "x.id::text",
    columns: `x.id, ${fieldColumns(TRIP_FIELDS)}`,
    map: (r) => ({ id: r.id, ...fieldValues(TRIP_FIELDS, r), updatedAt: r.updated_at }),
  },
  savedSpots: {
    kind: "saved_spot",
    from: "saved_spots x",
    user: "x.user_id",
    key: "x.id::text",
    columns: `x.id, ${fieldColumns(SPOT_FIELDS)}`,
    map: (r) => ({ id: r.id, ...fieldValues(SPOT_FIELDS, r), updatedAt: r.updated_at }),
  },
  albumCaptures: memberEntity("album_capture", "album_captures"),
  albumExclusions: memberEntity("album_exclusion", "album_exclusions"),
  phoneAlbumCaptures: memberEntity("album_capture", "album_captures", true),
  phoneAlbumExclusions: memberEntity("album_exclusion", "album_exclusions", true),
  speciesSplitKept: {
    kind: "species_split_kept",
    from: "species_split_kept x JOIN captures_all c ON c.id = x.capture_id",
    user: "c.user_id",
    key: "COALESCE(c.remote_id, c.id)::text",
    columns: "COALESCE(c.remote_id, c.id) AS capture_id",
    map: (r) => ({ captureId: r.capture_id, updatedAt: r.updated_at }),
  },
  smartTagHidden: {
    kind: "smart_tag_hidden",
    from: "smart_tag_hidden_terms x",
    user: "x.user_id",
    key: "x.term_id",
    columns: "x.term_id",
    map: (r) => ({ termId: r.term_id, updatedAt: r.updated_at }),
  },
} satisfies Record<string, Entity>;
export type EntityName = keyof typeof ENTITIES;

const STAMP = `, ${isoStamp("x.updated_at")} AS updated_at`;

// Same open-transaction hold as the capture feed: see changes.ts.
async function commitHorizon(db: Db): Promise<string> {
  const res = await db.query<{ h: string }>(
    `SELECT COALESCE(min(xact_start), clock_timestamp())::text AS h FROM pg_stat_activity
     WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()
       AND xact_start IS NOT NULL`,
  );
  return res.rows[0].h;
}

/** A user's rows of one entity in the order they changed, paged by (updated_at, ref), with the
 *  refs of rows deleted since from the tombstones. */
export async function listLibraryChanges(
  db: Db,
  userId: string,
  name: EntityName,
  cursor: LibraryCursor,
  limit: number,
) {
  const e: Entity = ENTITIES[name];
  const horizon = await commitHorizon(db);
  const keys = await db.query<{ ref: string; at: string; purged: boolean }>(
    `SELECT u.ref, ${isoStamp("u.at")} AS at, u.purged FROM (
       (SELECT x.updated_at AS at, ${e.key} AS ref, false AS purged FROM ${e.from}
        WHERE ${e.user} = $1 AND (x.updated_at, (${e.key}) COLLATE "C") > ($2::timestamptz, $3::text COLLATE "C")
          AND x.updated_at < $5::timestamptz
        ORDER BY x.updated_at, (${e.key}) COLLATE "C" LIMIT $4)
       UNION ALL
       (SELECT t.deleted_at, t.ref, true FROM sync_tombstones t
        WHERE t.user_id = $1 AND t.kind = '${e.kind}' AND (t.deleted_at, t.ref COLLATE "C") > ($2::timestamptz, $3::text COLLATE "C")
          AND t.deleted_at < $5::timestamptz
        ORDER BY t.deleted_at, t.ref COLLATE "C" LIMIT $4)
     ) u ORDER BY u.at, u.ref COLLATE "C" LIMIT $4`,
    [userId, cursor.since, cursor.after, limit, horizon],
  );
  const live = keys.rows.filter((r) => !r.purged).map((r) => r.ref);
  const rows = live.length
    ? (
        await db.query(
          `SELECT ${e.key} AS ref, ${e.columns}${STAMP} FROM ${e.from} WHERE ${e.user} = $1 AND ${e.key} = ANY($2::text[])`,
          [userId, live],
        )
      ).rows
    : [];
  const byRef = new Map(rows.map((r) => [r.ref as string, e.map(r)]));
  const end = keys.rows.at(-1);
  const last = end ? { since: end.at, after: end.ref } : null;
  return {
    items: live.flatMap((ref) => (byRef.has(ref) ? [byRef.get(ref)] : [])),
    purged: keys.rows.filter((r) => r.purged).map((r) => ({ ref: r.ref, deletedAt: r.at })),
    last,
    next: keys.rows.length === limit ? last : null,
  };
}

/** The server's albums, trips or saved spots by id, as the feed sends them. */
export async function rowsById(db: Db, userId: string, name: "albums" | "trips" | "savedSpots", ids: string[]) {
  const e: Entity = ENTITIES[name];
  if (ids.length === 0) return new Map<string, unknown>();
  const res = await db.query(
    `SELECT ${e.key} AS ref, ${e.columns}${STAMP} FROM ${e.from} WHERE ${e.user} = $1 AND ${e.key} = ANY($2::text[])`,
    [userId, ids],
  );
  return new Map(res.rows.map((r) => [r.ref as string, e.map(r)]));
}

// --- Push ---

export const RowOutcomeSchema = Type.Union([
  Type.Object({ id: Uuid(), status: Type.Literal("updated"), updatedAt: Stamp }),
  Type.Object({
    id: Uuid(),
    status: Type.Literal("conflict"),
    /** The receiver's copy, which the sender takes; null when the receiver deleted it. */
    current: Nullable(Type.Union([AlbumChangeSchema, TripChangeSchema, SpotChangeSchema])),
  }),
]);
export type RowOutcome = Static<typeof RowOutcomeSchema>;

export const LibraryReplySchema = Type.Object({
  albums: Type.Array(RowOutcomeSchema),
  trips: Type.Array(RowOutcomeSchema),
  savedSpots: Type.Array(RowOutcomeSchema),
  /** Membership rows written, and ones skipped because the album or capture isn't here yet. */
  members: Type.Object({ applied: Type.Integer(), skipped: Type.Integer() }),
  deleted: Type.Integer({ description: "Albums, trips, saved spots and membership rows removed" }),
});
export type LibraryReply = Static<typeof LibraryReplySchema>;

export const fieldParam = (f: Field, n: number) => (f.write ? f.write.replaceAll("{}", `$${n}`) : `$${n}::${f.type}`);

/** A row's field values as query parameters (JSON text for jsonb), in `fields` order. */
export const fieldParams = (fields: Field[], item: object) =>
  fields.map((f) => {
    const v = (item as Record<string, unknown>)[f.prop] ?? null;
    return f.type === "jsonb" && v !== null ? JSON.stringify(v) : v;
  });

/** A pushed spot whose name another spot here already uses (case-insensitive) gets " (2)", " (3)"
 *  and so on; the sender picks the new name up from the feed. */
async function withFreeSpotName(db: Db, userId: string, spot: PushedSpot): Promise<PushedSpot> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? spot.name : `${spot.name.slice(0, 490)} (${n})`;
    const taken = await db.query(
      "SELECT 1 FROM saved_spots WHERE user_id = $1 AND lower(name) = lower($2) AND id <> $3::uuid",
      [userId, name, spot.id],
    );
    if (taken.rowCount === 0) return { ...spot, name };
  }
}

/** Writes albums or trips the sender pushed: a new one is inserted, an existing one only if it is
 *  unchanged since the sender's base. */
export async function applyPushedRows(
  db: Db,
  userId: string,
  name: "albums" | "trips" | "savedSpots",
  items: (PushedAlbum | PushedTrip | PushedSpot)[],
): Promise<RowOutcome[]> {
  const fields = { albums: ALBUM_FIELDS, trips: TRIP_FIELDS, savedSpots: SPOT_FIELDS }[name];
  const table = name === "savedSpots" ? "saved_spots" : name;
  const outcomes: RowOutcome[] = [];
  const conflicted: string[] = [];
  // $1 user, $2 id, $3 base; the fields follow.
  const params = fields.map((f, i) => fieldParam(f, i + 4));
  const sets = fields.map((f, i) => `${f.column} = ${params[i]}`).join(", ");
  for (const pushed of items) {
    const item = name === "savedSpots" ? await withFreeSpotName(db, userId, pushed as PushedSpot) : pushed;
    const values = fieldParams(fields, item);
    const res = await db.query<{ updated_at: string }>(
      `INSERT INTO ${table} (user_id, id, ${fields.map((f) => f.column).join(", ")})
       SELECT $1::uuid, $2::uuid, ${params.join(", ")}
       -- A base with no row means the receiver deleted it: a conflict, not a new row.
       WHERE $3::timestamptz IS NULL OR EXISTS (SELECT 1 FROM ${table} WHERE id = $2::uuid)
       ON CONFLICT (id) DO UPDATE SET ${sets}
         WHERE ${table}.user_id = $1 AND $3::timestamptz IS NOT NULL AND ${table}.updated_at <= $3::timestamptz
       RETURNING ${isoStamp("updated_at")} AS updated_at`,
      [userId, item.id, item.baseUpdatedAt, ...values],
    );
    const updatedAt = res.rows[0]?.updated_at;
    if (updatedAt) outcomes.push({ id: item.id, status: "updated", updatedAt });
    else {
      conflicted.push(item.id);
      outcomes.push({ id: item.id, status: "conflict", current: null });
    }
  }
  const current = await rowsById(db, userId, name, conflicted);
  for (const o of outcomes) {
    if (o.status === "conflict")
      o.current = (current.get(o.id) as AlbumChange | TripChange | SpotChange | undefined) ?? null;
  }
  return outcomes;
}

/** Adds membership rows whose album and capture both belong to the user here. */
export async function applyPushedMembers(
  db: Db,
  userId: string,
  table: "album_captures" | "album_exclusions",
  rows: PushedMember[],
): Promise<{ applied: number; skipped: number }> {
  if (rows.length === 0) return { applied: 0, skipped: 0 };
  const res = await db.query(
    `INSERT INTO ${table} (album_id, capture_id)
     SELECT a.id, c.id FROM unnest($2::uuid[], $3::uuid[]) AS v(album_id, capture_id)
     JOIN albums a ON a.id = v.album_id AND a.user_id = $1
     JOIN captures_all c ON c.id = v.capture_id AND c.user_id = $1
     ON CONFLICT DO NOTHING`,
    [userId, rows.map((r) => r.albumId), rows.map((r) => r.captureId)],
  );
  const written = res.rowCount ?? 0;
  return { applied: written, skipped: rows.length - written };
}

/** Marks the sender's kept-after-split photos that exist here; idempotent. */
export async function applyPushedKept(db: Db, userId: string, captureIds: string[]): Promise<number> {
  if (captureIds.length === 0) return 0;
  const res = await db.query(
    `INSERT INTO species_split_kept (capture_id)
     SELECT c.id FROM captures_all c WHERE c.id = ANY($2::uuid[]) AND c.user_id = $1
     ON CONFLICT DO NOTHING`,
    [userId, captureIds],
  );
  return res.rowCount ?? 0;
}

/** Hides the sender's hidden smart tag terms here too; idempotent. */
export async function applyPushedHidden(db: Db, userId: string, termIds: string[]): Promise<number> {
  if (termIds.length === 0) return 0;
  const res = await db.query(
    `INSERT INTO smart_tag_hidden_terms (user_id, term_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
    [userId, termIds],
  );
  return res.rowCount ?? 0;
}

/** Deletes what the sender deleted: an album or trip only if unchanged since its base. */
export async function applyPushedLibraryDeletions(
  db: Db,
  userId: string,
  deleted: {
    albums?: { id: string; baseUpdatedAt: string | null }[];
    trips?: { id: string; baseUpdatedAt: string | null }[];
    savedSpots?: { id: string; baseUpdatedAt: string | null }[];
    albumCaptures?: PushedMember[];
    albumExclusions?: PushedMember[];
    speciesSplitKept?: string[];
    smartTagHidden?: string[];
  },
): Promise<number> {
  let n = 0;
  if (deleted.smartTagHidden?.length) {
    const res = await db.query(`DELETE FROM smart_tag_hidden_terms WHERE user_id = $1 AND term_id = ANY($2::text[])`, [
      userId,
      deleted.smartTagHidden,
    ]);
    n += res.rowCount ?? 0;
  }
  if (deleted.speciesSplitKept?.length) {
    const res = await db.query(
      `DELETE FROM species_split_kept k USING captures_all c
       WHERE c.id = k.capture_id AND c.user_id = $1 AND c.id = ANY($2::uuid[])`,
      [userId, deleted.speciesSplitKept],
    );
    n += res.rowCount ?? 0;
  }
  for (const [key, table] of [
    ["albums", "albums"],
    ["trips", "trips"],
    ["savedSpots", "saved_spots"],
  ] as const) {
    const rows = deleted[key] ?? [];
    if (rows.length === 0) continue;
    const res = await db.query(
      `DELETE FROM ${table} t USING unnest($2::uuid[], $3::timestamptz[]) AS d(id, base)
       WHERE t.user_id = $1 AND t.id = d.id AND (d.base IS NULL OR t.updated_at <= d.base)`,
      [userId, rows.map((r) => r.id), rows.map((r) => r.baseUpdatedAt)],
    );
    n += res.rowCount ?? 0;
  }
  for (const [key, table] of [
    ["albumCaptures", "album_captures"],
    ["albumExclusions", "album_exclusions"],
  ] as const) {
    const rows = deleted[key] ?? [];
    if (rows.length === 0) continue;
    const res = await db.query(
      `DELETE FROM ${table} m USING unnest($2::uuid[], $3::uuid[]) AS d(album_id, capture_id), albums a
       WHERE a.id = m.album_id AND a.user_id = $1 AND m.album_id = d.album_id AND m.capture_id = d.capture_id`,
      [userId, rows.map((r) => r.albumId), rows.map((r) => r.captureId)],
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

/** Everything library-shaped in one push, deletions first; the reply's `library` part. */
export async function applyPushedLibrary(
  db: Db,
  userId: string,
  body: {
    albums?: PushedAlbum[];
    trips?: PushedTrip[];
    savedSpots?: PushedSpot[];
    albumCaptures?: PushedMember[];
    albumExclusions?: PushedMember[];
    speciesSplitKept?: string[];
    smartTagHidden?: string[];
  },
  deleted: Parameters<typeof applyPushedLibraryDeletions>[2],
): Promise<LibraryReply> {
  const removed = await applyPushedLibraryDeletions(db, userId, deleted);
  const albums = await applyPushedRows(db, userId, "albums", body.albums ?? []);
  const trips = await applyPushedRows(db, userId, "trips", body.trips ?? []);
  const savedSpots = await applyPushedRows(db, userId, "savedSpots", body.savedSpots ?? []);
  const a = await applyPushedMembers(db, userId, "album_captures", body.albumCaptures ?? []);
  const b = await applyPushedMembers(db, userId, "album_exclusions", body.albumExclusions ?? []);
  const kept = body.speciesSplitKept ?? [];
  const k = await applyPushedKept(db, userId, kept);
  // A term already hidden here counts as applied: the set is the same either way.
  const hidden = body.smartTagHidden ?? [];
  await applyPushedHidden(db, userId, hidden);
  return {
    albums,
    trips,
    savedSpots,
    members: {
      applied: a.applied + b.applied + k + hidden.length,
      skipped: a.skipped + b.skipped + kept.length - k,
    },
    deleted: removed,
  };
}
