// What a desktop app and its linked server send each other, in one place: the shapes (checked
// on both ends), the capture columns and the row mappers. The server's side of the mirror lives
// here too: a user's captures in the order they changed, paged by (updated_at, id), with the
// fields a linked desktop app needs to show the collection without the originals. Trashed
// captures come through with deletedAt set; captures deleted outright come as `purged` ids from
// the tombstones (migration 152). Species go by scientific name: ids differ between installs.
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { Type, type Static } from "typebox";
import { APPEARANCE_TEXT_MAX, LIFE_STAGES, SEXES } from "@lifer/shared";
import { Nullable, Uuid } from "../lib/schema.js";

type Db = Pick<Pool | PoolClient, "query">;

const At = Nullable(Type.String({ format: "date-time" }));
const Text = Nullable(Type.String({ maxLength: 2000 }));
const Num = Nullable(Type.Number());

/** The capture fields both sides send. Generous caps: a row the server already holds must never
 *  fail the check and hold up every later pull. */
export const captureFields = {
  id: Uuid(),
  deletedAt: At,
  hiddenAt: At,
  scientificName: Type.String({ minLength: 1, maxLength: 500 }),
  fingerprint: Type.String({ minLength: 1, maxLength: 500 }),
  takenAt: At,
  lat: Num,
  lon: Num,
  cameraModel: Text,
  lens: Text,
  focalLengthMm: Num,
  aperture: Num,
  shutter: Text,
  iso: Nullable(Type.Integer()),
  qualityRating: Nullable(Type.Integer({ minimum: 1, maximum: 5 })),
  tags: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 1000 }),
  locationLabel: Text,
  /** Where the point came from (migration 181): null for camera GPS, so a place never moves it. */
  locationSource: Type.Optional(
    Nullable(Type.Union([Type.Literal("inaturalist"), Type.Literal("spot"), Type.Literal("map")])),
  ),
  locationAccuracyM: Type.Optional(Num),
  regionId: Nullable(Uuid()),
  cullVerdict: Nullable(Type.Union([Type.Literal("pick"), Type.Literal("reject")])),
  cullLabel: Text,
  /** Optional so an older desktop's push, which lacks it, leaves the server's trip as it is. */
  tripId: Type.Optional(Nullable(Uuid())),
  // How the animal looks (migration 196).
  lifeStage: Type.Optional(Nullable(Type.Enum([...LIFE_STAGES]))),
  sex: Type.Optional(Nullable(Type.Enum([...SEXES]))),
  plumage: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: APPEARANCE_TEXT_MAX }))),
  morph: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: APPEARANCE_TEXT_MAX }))),
  // Smart tag decisions (migration 208). Optional: a sender that leaves them out keeps the receiver's.
  smartTagsAccepted: Type.Optional(
    Type.Record(Type.String({ maxLength: 200 }), Type.String({ maxLength: 2000 }), {
      description: "Accepted smart tags: vocabulary term id to the tag it added",
    }),
  ),
  smartTagsRejected: Type.Optional(
    Type.Array(Type.String({ maxLength: 200 }), { maxItems: 1000, description: "Smart tag term ids rejected" }),
  ),
};

export const CaptureChangeSchema = Type.Object({
  ...captureFields,
  // To the microsecond (isoStamp): a JS Date rounds to milliseconds, and a cursor rounded down
  // would hand back the same rows again.
  updatedAt: Type.String({ format: "date-time" }),
  photo: Nullable(
    Type.Object({
      id: Uuid(),
      width: Nullable(Type.Integer()),
      height: Nullable(Type.Integer()),
      kind: Type.String({ maxLength: 32 }),
      durationSeconds: Num,
    }),
  ),
});
export type CaptureChange = Static<typeof CaptureChangeSchema>;

const CursorSchema = Type.Object({ since: Type.String({ format: "date-time" }), after: Uuid() });
export type ChangeCursor = Static<typeof CursorSchema>;

export const FIRST_CURSOR: ChangeCursor = {
  since: "1970-01-01T00:00:00Z",
  after: "00000000-0000-0000-0000-000000000000",
};

export const ChangesPageSchema = Type.Object({
  items: Type.Array(CaptureChangeSchema),
  /** Captures deleted outright since the cursor. */
  purged: Type.Array(Type.Object({ id: Uuid(), deletedAt: Type.String({ format: "date-time" }) })),
  /** Where this page ended, null when it was empty. */
  last: Nullable(CursorSchema),
  /** Where the next page starts, null on the last page. */
  next: Nullable(CursorSchema),
});
export type ChangesPage = Static<typeof ChangesPageSchema>;

/** A timestamptz column as ISO 8601 text to the microsecond, which the date-time format accepts
 *  and Postgres reads back exactly. */
export const isoStamp = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The columns captureFromRow reads besides id and updated_at, over captures_all c, species s and photos p. */
export const CAPTURE_COLUMNS = `c.deleted_at, c.hidden_at, s.scientific_name,
  c.fingerprint, c.taken_at, c.lat, c.lon, c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso,
  c.quality_rating, c.tags, c.location_label, c.location_source, c.location_accuracy_m, c.region_id, c.cull_verdict, c.cull_label, c.trip_id,
  c.life_stage, c.sex, c.plumage, c.morph, c.smart_tags_accepted, c.smart_tags_rejected,
  p.id AS photo_id, p.width, p.height, p.kind AS photo_kind, p.duration_seconds`;

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
const num = (v: string | number | null) => (v == null ? null : Number(v));

export function captureFromRow(r: QueryResultRow): CaptureChange {
  return {
    id: r.id,
    updatedAt: r.updated_at,
    deletedAt: iso(r.deleted_at),
    hiddenAt: iso(r.hidden_at),
    scientificName: r.scientific_name,
    fingerprint: r.fingerprint,
    takenAt: iso(r.taken_at),
    lat: num(r.lat),
    lon: num(r.lon),
    cameraModel: r.camera_model,
    lens: r.lens,
    focalLengthMm: num(r.focal_length_mm),
    aperture: num(r.aperture),
    shutter: r.shutter,
    iso: r.iso,
    qualityRating: r.quality_rating,
    tags: r.tags ?? [],
    locationLabel: r.location_label,
    locationSource: r.location_source ?? null,
    locationAccuracyM: num(r.location_accuracy_m),
    regionId: r.region_id,
    cullVerdict: r.cull_verdict,
    cullLabel: r.cull_label,
    tripId: r.trip_id ?? null,
    lifeStage: r.life_stage ?? null,
    sex: r.sex ?? null,
    plumage: r.plumage ?? null,
    morph: r.morph ?? null,
    smartTagsAccepted: r.smart_tags_accepted ?? {},
    smartTagsRejected: r.smart_tags_rejected ?? [],
    photo: r.photo_id
      ? {
          id: r.photo_id,
          width: r.width,
          height: r.height,
          kind: r.photo_kind,
          durationSeconds: num(r.duration_seconds),
        }
      : null,
  };
}

/** The metadata columns both sides write as sent, with the field each comes from. */
export const CAPTURE_META = [
  ["taken_at", "takenAt"],
  ["lat", "lat"],
  ["lon", "lon"],
  ["camera_model", "cameraModel"],
  ["lens", "lens"],
  ["focal_length_mm", "focalLengthMm"],
  ["aperture", "aperture"],
  ["shutter", "shutter"],
  ["iso", "iso"],
  ["quality_rating", "qualityRating"],
  ["tags", "tags"],
  ["location_label", "locationLabel"],
  ["location_source", "locationSource"],
  ["location_accuracy_m", "locationAccuracyM"],
  ["cull_verdict", "cullVerdict"],
  ["cull_label", "cullLabel"],
  ["hidden_at", "hiddenAt"],
  ["life_stage", "lifeStage"],
  ["sex", "sex"],
  ["plumage", "plumage"],
  ["morph", "morph"],
  // Left out by the sender: sent as NULL, which the trigger in migration 208 reads as "keep".
  ["smart_tags_accepted", "smartTagsAccepted"],
  ["smart_tags_rejected", "smartTagsRejected"],
] as const satisfies ReadonlyArray<readonly [string, keyof CaptureChange]>;

/** The server's captures by id, as listChanges sends them. */
export async function capturesById(db: Db, userId: string, ids: string[]): Promise<Map<string, CaptureChange>> {
  if (ids.length === 0) return new Map();
  const res = await db.query(
    `SELECT c.id, ${isoStamp("c.updated_at")} AS updated_at, ${CAPTURE_COLUMNS} FROM captures_all c JOIN species s ON s.id = c.species_id
     LEFT JOIN photos p ON p.id = c.current_photo_id WHERE c.user_id = $1 AND c.id = ANY($2::uuid[])`,
    [userId, ids],
  );
  return new Map(res.rows.map((r) => [r.id, captureFromRow(r)]));
}

// Every row stamped before the oldest transaction still open is committed: the triggers stamp
// now(), a transaction's start, so whatever commits later carries a stamp at or after it. A
// cursor that moved past such a stamp would skip that row for good, however long the
// transaction ran. Read in its own statement, so the page's snapshot is taken after it.
export async function commitHorizon(db: Db): Promise<string> {
  const res = await db.query<{ h: string }>(
    `SELECT COALESCE(min(xact_start), clock_timestamp())::text AS h FROM pg_stat_activity
     WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()
       AND xact_start IS NOT NULL`,
  );
  return res.rows[0].h;
}

export async function listChanges(db: Db, userId: string, cursor: ChangeCursor, limit: number): Promise<ChangesPage> {
  const horizon = await commitHorizon(db);
  const res = await db.query(
    `SELECT u.id, ${isoStamp("u.at")} AS updated_at, u.purged, ${CAPTURE_COLUMNS}
     FROM (
       (SELECT c.updated_at AS at, c.id, false AS purged FROM captures_all c
        WHERE c.user_id = $1 AND (c.updated_at, c.id) > ($2::timestamptz, $3::uuid) AND c.updated_at < $5::timestamptz
        ORDER BY c.updated_at, c.id LIMIT $4)
       UNION ALL
       (SELECT t.deleted_at, t.ref::uuid, true FROM sync_tombstones t
        WHERE t.user_id = $1 AND t.kind = 'capture' AND (t.deleted_at, t.ref::uuid) > ($2::timestamptz, $3::uuid)
          AND t.deleted_at < $5::timestamptz
        ORDER BY t.deleted_at, t.ref::uuid LIMIT $4)
       ORDER BY at, id LIMIT $4
     ) u
     LEFT JOIN captures_all c ON NOT u.purged AND c.id = u.id
     LEFT JOIN species s ON s.id = c.species_id
     LEFT JOIN photos p ON p.id = c.current_photo_id
     ORDER BY u.at, u.id`,
    [userId, cursor.since, cursor.after, limit, horizon],
  );
  const items = res.rows.filter((r) => !r.purged).map(captureFromRow);
  const purged = res.rows
    .filter((r) => r.purged)
    .map((r) => ({ id: r.id as string, deletedAt: r.updated_at as string }));
  const end = res.rows.at(-1);
  const last = end ? { since: end.updated_at as string, after: end.id as string } : null;
  return { items, purged, last, next: res.rows.length === limit ? last : null };
}

export const UserSpeciesSchema = Type.Object({
  scientificName: Type.String({ minLength: 1, maxLength: 500 }),
  state: Nullable(Type.Union([Type.Literal("collected"), Type.Literal("seen")])),
  coverPhotoId: Nullable(Uuid()),
  firstCollected: Nullable(Type.String({ format: "date" })),
  bestQuality: Nullable(Type.Integer({ minimum: 1, maximum: 5 })),
  cardCropX: Num,
  cardCropY: Num,
  cardCropSize: Num,
  isTarget: Type.Boolean(),
  /** Optional so a sender that leaves it out keeps the mark as it is here. */
  needsBetterPhoto: Type.Optional(Type.Boolean()),
  /** The sender's version of the mark, to the microsecond (isoStamp). */
  updatedAt: Type.Optional(Type.String({ format: "date-time" })),
});
export type UserSpeciesRow = Static<typeof UserSpeciesSchema>;
export const UserSpeciesListSchema = Type.Object({ items: Type.Array(UserSpeciesSchema) });

/** The columns userSpeciesFromRow reads, over user_species us and species s. */
export const USER_SPECIES_COLUMNS = `s.scientific_name, us.state, us.cover_photo_id, us.first_collected, us.best_quality,
  us.card_crop_x, us.card_crop_y, us.card_crop_size, us.is_target, us.needs_better_photo, ${isoStamp("us.updated_at")} AS updated_at`;

export function userSpeciesFromRow(r: QueryResultRow): UserSpeciesRow {
  return {
    scientificName: r.scientific_name,
    state: r.state,
    coverPhotoId: r.cover_photo_id,
    firstCollected: r.first_collected ? new Date(r.first_collected).toISOString().slice(0, 10) : null,
    bestQuality: r.best_quality,
    cardCropX: num(r.card_crop_x),
    cardCropY: num(r.card_crop_y),
    cardCropSize: num(r.card_crop_size),
    isTarget: r.is_target,
    needsBetterPhoto: r.needs_better_photo,
    updatedAt: r.updated_at,
  };
}

/** Every per-species mark the user has (seen, targets, card crops), small enough to send whole. */
export async function listUserSpecies(db: Db, userId: string): Promise<UserSpeciesRow[]> {
  const res = await db.query(
    `SELECT ${USER_SPECIES_COLUMNS} FROM user_species us JOIN species s ON s.id = us.species_id WHERE us.user_id = $1`,
    [userId],
  );
  return res.rows.map(userSpeciesFromRow);
}

/** The user's marks for these species, as listUserSpecies sends them. */
export async function listUserSpeciesByName(db: Db, userId: string, names: string[]): Promise<UserSpeciesRow[]> {
  if (names.length === 0) return [];
  const res = await db.query(
    `SELECT ${USER_SPECIES_COLUMNS} FROM user_species us JOIN species s ON s.id = us.species_id
     WHERE us.user_id = $1 AND s.scientific_name = ANY($2)`,
    [userId, names],
  );
  return res.rows.map(userSpeciesFromRow);
}

/** Whether the user still has a photo of the species: a mark that follows from one isn't deleted. */
const HAS_LIVE_CAPTURE = `EXISTS (SELECT 1 FROM captures_all lc WHERE lc.user_id = us.user_id AND lc.deleted_at IS NULL
    AND (lc.species_id = us.species_id
      OR EXISTS (SELECT 1 FROM capture_species cs WHERE cs.capture_id = lc.id AND cs.species_id = us.species_id)))`;

/** A mark as pushed: the version of the server's copy the desktop last had, null if it never had one. */
export type PushedUserSpecies = UserSpeciesRow & { baseUpdatedAt?: string | null };

/** Writes species marks by name in one statement; species this catalog lacks are skipped. A
 *  mirrored write (the desktop taking the server's copy) records it as pushed with the server's
 *  version and never overwrites a mark changed here and not pushed yet, unless `force` (a
 *  conflict the server won). A pushed mark with a base is written only if the row here hasn't
 *  changed since it; the names that weren't come back as `conflicts`. Returns what was written. */
export async function upsertUserSpeciesDetailed(
  db: Db,
  userId: string,
  rows: PushedUserSpecies[],
  { mirrored, force = false }: { mirrored: boolean; force?: boolean },
): Promise<{ written: { name: string; updatedAt: string }[]; conflicts: string[] }> {
  let unique = [...new Map(rows.map((r) => [r.scientificName, r])).values()];
  let conflicts: string[] = [];
  if (!mirrored && unique.length > 0) {
    const stale = await db.query<{ name: string }>(
      `SELECT s.scientific_name AS name FROM user_species us JOIN species s ON s.id = us.species_id
       JOIN unnest($2::text[], $3::timestamptz[]) AS v(name, base) ON v.name = s.scientific_name
       WHERE us.user_id = $1 AND v.base IS NOT NULL AND us.updated_at > v.base`,
      [userId, unique.map((r) => r.scientificName), unique.map((r) => r.baseUpdatedAt ?? null)],
    );
    conflicts = [...new Set(stale.rows.map((r) => r.name))];
    unique = unique.filter((r) => !conflicts.includes(r.scientificName));
  }
  if (unique.length === 0) return { written: [], conflicts };
  const col = <K extends keyof PushedUserSpecies>(k: K) => unique.map((r) => r[k] ?? null);
  const res = await db.query(
    `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, cover_chosen_photo_id, first_collected, best_quality,
       card_crop_x, card_crop_y, card_crop_size, is_target, needs_better_photo, pushed_at, remote_updated_at)
     SELECT $1, s.id, v.state,
       (SELECT p.id FROM photos p JOIN captures_all c ON c.id = p.capture_id WHERE p.id = v.cover AND c.user_id = $1),
       -- A synced cover may be the user's pick on the other side, so it never moves on its own here.
       (SELECT p.id FROM photos p JOIN captures_all c ON c.id = p.capture_id WHERE p.id = v.cover AND c.user_id = $1),
       v.first_collected, v.best_quality, v.x, v.y, v.size, v.is_target,
       -- Left out by the sender: keep this side's mark.
       COALESCE(v.needs_better, (SELECT x.needs_better_photo FROM user_species x WHERE x.user_id = $1 AND x.species_id = s.id), false),
       ${mirrored ? "now()" : "NULL::timestamptz"},
       ${mirrored ? "v.stamp" : "NULL::timestamptz"}
     FROM unnest($2::text[], $3::text[], $4::uuid[], $5::date[], $6::int[], $7::numeric[], $8::numeric[],
                 $9::numeric[], $10::bool[], $11::timestamptz[], $12::bool[])
       AS v(name, state, cover, first_collected, best_quality, x, y, size, is_target, stamp, needs_better)
     JOIN (SELECT DISTINCT ON (scientific_name) id, scientific_name FROM species
           WHERE scientific_name = ANY($2) ORDER BY scientific_name, id) s ON s.scientific_name = v.name
     ON CONFLICT (user_id, species_id) DO UPDATE SET state = EXCLUDED.state,
       cover_photo_id = COALESCE(EXCLUDED.cover_photo_id, user_species.cover_photo_id),
       cover_chosen_photo_id = CASE WHEN EXCLUDED.cover_photo_id IS DISTINCT FROM user_species.cover_photo_id
         AND EXCLUDED.cover_photo_id IS NOT NULL THEN EXCLUDED.cover_photo_id ELSE user_species.cover_chosen_photo_id END,
       first_collected = EXCLUDED.first_collected, best_quality = EXCLUDED.best_quality,
       card_crop_x = EXCLUDED.card_crop_x, card_crop_y = EXCLUDED.card_crop_y,
       card_crop_size = EXCLUDED.card_crop_size, is_target = EXCLUDED.is_target,
       needs_better_photo = EXCLUDED.needs_better_photo
       ${mirrored ? `, pushed_at = now(), remote_updated_at = EXCLUDED.remote_updated_at ${force ? "" : "WHERE user_species.pushed_at IS NOT NULL AND user_species.updated_at <= user_species.pushed_at"}` : ""}
     RETURNING (SELECT scientific_name FROM species WHERE id = user_species.species_id) AS name,
       ${isoStamp("user_species.updated_at")} AS stamp`,
    [
      userId,
      col("scientificName"),
      col("state"),
      col("coverPhotoId"),
      col("firstCollected"),
      col("bestQuality"),
      col("cardCropX"),
      col("cardCropY"),
      col("cardCropSize"),
      col("isTarget"),
      col("updatedAt"),
      col("needsBetterPhoto"),
    ],
  );
  return { written: res.rows.map((r) => ({ name: r.name, updatedAt: r.stamp })), conflicts };
}

/** upsertUserSpeciesDetailed, as how many were written. */
export async function upsertUserSpecies(
  db: Db,
  userId: string,
  rows: PushedUserSpecies[],
  options: { mirrored: boolean; force?: boolean },
): Promise<number> {
  return (await upsertUserSpeciesDetailed(db, userId, rows, options)).written.length;
}

/** Deletes the user's marks for these species, or (`keep`) every mark except these, leaving any
 *  the user still has a photo of. A mirrored delete also leaves marks changed here and not pushed. */
export async function deleteUserSpecies(
  db: Db,
  userId: string,
  names: string[],
  { keep, mirrored }: { keep: boolean; mirrored: boolean },
): Promise<number> {
  if (!keep && names.length === 0) return 0;
  const res = await db.query(
    `DELETE FROM user_species us USING species s
     WHERE us.user_id = $1 AND s.id = us.species_id AND ${keep ? "s.scientific_name <> ALL($2)" : "s.scientific_name = ANY($2)"}
       AND NOT ${HAS_LIVE_CAPTURE}
       ${mirrored ? "AND us.pushed_at IS NOT NULL AND us.updated_at <= us.pushed_at" : ""}`,
    [userId, names],
  );
  return res.rowCount ?? 0;
}

/** Marks this transaction's writes as sync applying the other side's changes, so its deletes
 *  leave no tombstones to send back (migration 152). */
export async function asSyncApply(db: Db): Promise<void> {
  await db.query(`SELECT set_config('lifer.sync_apply', 'on', true)`);
}
