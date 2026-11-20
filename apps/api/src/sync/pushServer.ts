// The server's side of a desktop push: metadata for captures the desktop already sent or that
// exist here anyway, the user's species marks, and what the desktop deleted. A capture is found
// by the id the two installs share, else by its fingerprint among live captures (the same photo
// imported on both sides). One the server doesn't have at all is answered "needs-file": the
// desktop then uploads it like any import and pushes its metadata again.
//
// The newest edit wins. Each capture carries the server's updated_at the desktop last had
// (baseUpdatedAt); it's written only if the row hasn't changed here since, otherwise the answer
// is "conflict" with the server's copy, which the desktop takes. With no base, a capture found by
// id is one the desktop uploaded itself and is written, but never brought back from the trash;
// one found only by fingerprint is a conflict. A capture purged here is a conflict with no copy.
import type { Pool, PoolClient } from "pg";
import { Type, type Static } from "typebox";
import { Nullable, Uuid } from "../lib/schema.js";
import { LibraryReplySchema } from "./library.js";
import {
  isoStamp,
  listUserSpeciesByName,
  UserSpeciesSchema,
  CAPTURE_META,
  CaptureChangeSchema,
  capturesById,
  deleteUserSpecies,
  upsertUserSpeciesDetailed,
  type CaptureChange,
  type PushedUserSpecies,
  type UserSpeciesRow,
} from "./changes.js";

type Db = Pick<Pool | PoolClient, "query">;

export type PushedCapture = Omit<CaptureChange, "updatedAt" | "photo"> & { baseUpdatedAt: string | null };

const Stamp = Type.String({ format: "date-time" });
export const PushOutcomeSchema = Type.Union([
  Type.Object({
    id: Uuid(),
    status: Type.Literal("updated"),
    /** The server's id for it, when it isn't the desktop's. */
    serverId: Type.Optional(Uuid()),
    /** The server's updated_at after the write: the base for the next push. */
    updatedAt: Stamp,
  }),
  Type.Object({ id: Uuid(), status: Type.Literal("needs-file") }),
  Type.Object({ id: Uuid(), status: Type.Literal("unknown-species") }),
  Type.Object({
    id: Uuid(),
    status: Type.Literal("conflict"),
    serverId: Type.Optional(Uuid()),
    /** The server's copy, which the desktop takes; null when the server purged it. */
    current: Nullable(CaptureChangeSchema),
  }),
]);
export type PushOutcome = Static<typeof PushOutcomeSchema>;
export const PushReplySchema = Type.Object({
  outcomes: Type.Array(PushOutcomeSchema),
  speciesIds: Type.Record(Type.String(), Nullable(Uuid())),
  userSpecies: Type.Integer(),
  /** The server's version of each mark it wrote: the base for the next push. */
  userSpeciesStamps: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** Marks changed here since the desktop's copy: the server's copy, which the desktop takes. */
  userSpeciesConflicts: Type.Optional(Type.Array(UserSpeciesSchema)),
  deleted: Type.Integer({ description: "Captures the desktop deleted that were trashed here" }),
  library: Type.Optional(LibraryReplySchema),
});

/** What the desktop deleted: captures by the server's id with the base it had, marks by name. */
export interface PushedDeletions {
  captures?: { id: string; baseUpdatedAt: string | null }[];
  userSpecies?: string[];
}

async function speciesByName(db: Db, names: string[]): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const res = await db.query<{ id: string; scientific_name: string }>(
    `SELECT DISTINCT ON (scientific_name) id, scientific_name FROM species WHERE scientific_name = ANY($1) ORDER BY scientific_name, id`,
    [names],
  );
  return new Map(res.rows.map((r) => [r.scientific_name, r.id]));
}

export async function applyPushedCaptures(
  db: Db,
  userId: string,
  items: PushedCapture[],
): Promise<{ outcomes: PushOutcome[]; speciesIds: Record<string, string | null> }> {
  const names = [...new Set(items.map((i) => i.scientificName))];
  const species = await speciesByName(db, names);
  const ids = items.map((i) => i.id);
  const found = await db.query<{ id: string; fingerprint: string; live: boolean }>(
    `SELECT id, fingerprint, deleted_at IS NULL AS live FROM captures_all
     WHERE user_id = $1 AND (id = ANY($2::uuid[]) OR (fingerprint = ANY($3::text[]) AND deleted_at IS NULL))
     ORDER BY id`,
    [userId, ids, items.map((i) => i.fingerprint)],
  );
  const byId = new Set(found.rows.map((r) => r.id));
  const byFingerprint = new Map<string, string>();
  for (const r of found.rows) if (r.live && !byFingerprint.has(r.fingerprint)) byFingerprint.set(r.fingerprint, r.id);
  const purged = new Set(
    (
      await db.query<{ ref: string }>(
        `SELECT ref FROM sync_tombstones WHERE user_id = $1 AND kind = 'capture' AND ref = ANY($2::text[])`,
        [userId, ids],
      )
    ).rows.map((r) => r.ref),
  );
  const regions = new Set(
    (
      await db.query<{ id: string }>(`SELECT id FROM regions WHERE id = ANY($1::uuid[])`, [
        items.flatMap((i) => (i.regionId ? [i.regionId] : [])),
      ])
    ).rows.map((r) => r.id),
  );

  const outcomes: PushOutcome[] = [];
  const conflicted: string[] = [];
  const conflict = (item: PushedCapture, serverId: string | null) => {
    if (serverId) conflicted.push(serverId);
    outcomes.push({
      id: item.id,
      status: "conflict",
      ...(serverId && serverId !== item.id && { serverId }),
      current: null,
    });
  };
  // $1-$5: id, user, species, region, base; the metadata follows in CAPTURE_META's order.
  const sets = CAPTURE_META.map(([column], i) => `${column} = $${i + 6}`).join(", ");
  const deletedParam = `$${CAPTURE_META.length + 6}`;
  const hasTrip = `$${CAPTURE_META.length + 7}`;
  const tripParam = `$${CAPTURE_META.length + 8}`;
  for (const item of items) {
    const speciesId = species.get(item.scientificName);
    const serverId = byId.has(item.id) ? item.id : byFingerprint.get(item.fingerprint);
    if (!serverId) {
      if (purged.has(item.id)) conflict(item, null);
      else outcomes.push({ id: item.id, status: speciesId ? "needs-file" : "unknown-species" });
      continue;
    }
    if (item.baseUpdatedAt === null && serverId !== item.id) {
      conflict(item, serverId);
      continue;
    }
    // A species this catalog lacks leaves the server's species as it is.
    const res = await db.query<{ updated_at: string }>(
      `UPDATE captures_all SET species_id = COALESCE($3, species_id), region_id = $4, ${sets}, deleted_at = ${deletedParam},
         trip_id = CASE WHEN ${hasTrip}::boolean THEN (SELECT id FROM trips WHERE id = ${tripParam}::uuid AND user_id = $2) ELSE trip_id END
       WHERE id = $1 AND user_id = $2
         AND CASE WHEN $5::timestamptz IS NULL THEN deleted_at IS NULL OR ${deletedParam}::timestamptz IS NOT NULL
                  ELSE updated_at <= $5::timestamptz END
       RETURNING ${isoStamp("updated_at")} AS updated_at`,
      [
        serverId,
        userId,
        speciesId ?? null,
        item.regionId && regions.has(item.regionId) ? item.regionId : null,
        item.baseUpdatedAt,
        ...CAPTURE_META.map(([, field]) => item[field]),
        item.deletedAt,
        item.tripId !== undefined,
        item.tripId ?? null,
      ],
    );
    const updatedAt = res.rows[0]?.updated_at;
    if (!updatedAt) {
      conflict(item, serverId);
      continue;
    }
    outcomes.push({ id: item.id, status: "updated", updatedAt, ...(serverId !== item.id && { serverId }) });
  }
  const current = await capturesById(db, userId, conflicted);
  for (const o of outcomes) {
    if (o.status === "conflict") o.current = current.get(o.serverId ?? o.id) ?? null;
  }
  return { outcomes, speciesIds: Object.fromEntries(names.map((n) => [n, species.get(n) ?? null])) };
}

/** Trashes captures the desktop deleted, unless they changed here since the desktop's copy. */
export async function applyPushedCaptureDeletions(
  db: Db,
  userId: string,
  deleted: NonNullable<PushedDeletions["captures"]>,
): Promise<number> {
  if (deleted.length === 0) return 0;
  const res = await db.query(
    `UPDATE captures_all c SET deleted_at = now()
     FROM unnest($2::uuid[], $3::timestamptz[]) AS d(id, base)
     WHERE c.user_id = $1 AND c.id = d.id AND c.deleted_at IS NULL AND (d.base IS NULL OR c.updated_at <= d.base)`,
    [userId, deleted.map((d) => d.id), deleted.map((d) => d.baseUpdatedAt)],
  );
  return res.rowCount ?? 0;
}

/** The desktop's species marks: what it deleted goes first, so a mark deleted then made again
 *  stays. A mark changed here since the desktop's copy isn't written; its current copy comes back. */
export async function applyPushedUserSpecies(
  db: Db,
  userId: string,
  rows: PushedUserSpecies[],
  deleted: string[] = [],
): Promise<{ count: number; stamps: Record<string, string>; conflicts: UserSpeciesRow[] }> {
  await deleteUserSpecies(db, userId, deleted, { keep: false, mirrored: false });
  const { written, conflicts } = await upsertUserSpeciesDetailed(db, userId, rows, { mirrored: false });
  return {
    count: written.length,
    stamps: Object.fromEntries(written.map((w) => [w.name, w.updatedAt])),
    conflicts: await listUserSpeciesByName(db, userId, conflicts),
  };
}
