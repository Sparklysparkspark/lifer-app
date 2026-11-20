// Unlinking a photo found on iNaturalist: the link records what its write-back changed on the
// photo (capture_inaturalist_observations.link_writes), and Unlink restores exactly that, only
// where the photo still holds what the link wrote, so a later edit is never undone.
import type { PoolClient } from "pg";
import { withTransaction } from "@lifer/core/db.js";
import { createLimiter } from "@lifer/core/lib/concurrency.js";
import { syncCaptureXmpSidecarsLogged } from "../uploads/xmpSidecarSync.js";
import { queueRecheck } from "../captures/recheck.js";

export const LINK_FIELDS = ["lat", "lon", "location_source", "location_accuracy_m", "region_id", "taken_at"] as const;
export type LinkField = (typeof LINK_FIELDS)[number];
/** The fields as Postgres prints them (::text), so before and after compare exactly. */
export type CaptureValues = Record<LinkField, string | null>;
export interface LinkWrites {
  fields: Partial<Record<LinkField, { from: string | null; to: string | null }>>;
  /** The photo's files were rewritten with the new values. */
  sidecar: boolean;
}

const LOCATION: LinkField[] = ["lat", "lon", "location_source", "location_accuracy_m"];

/** What changed between before and after, added to what the link wrote earlier (the first
 *  "from" is kept, so the record always points back to the photo as it was before linking). */
export function recordWrites(before: CaptureValues, after: CaptureValues, prior: LinkWrites | null): LinkWrites | null {
  const fields: LinkWrites["fields"] = { ...prior?.fields };
  let changed = false;
  for (const f of LINK_FIELDS) {
    if (before[f] === after[f]) continue;
    fields[f] = { from: prior?.fields[f]?.from ?? before[f], to: after[f] };
    changed = true;
  }
  if (!changed) return prior;
  return { fields, sidecar: true };
}

/** What Unlink may set back: each written field whose value is still the one the link wrote. A
 *  location goes back whole or not at all, so a moved pin is never half undone. */
export function revertFor(
  writes: LinkWrites | null,
  current: CaptureValues,
): { set: Partial<CaptureValues>; kept: LinkField[]; gps: boolean; place: boolean } {
  const set: Partial<CaptureValues> = {};
  const kept: LinkField[] = [];
  for (const [f, w] of Object.entries(writes?.fields ?? {}) as Array<
    [LinkField, { from: string | null; to: string | null }]
  >) {
    if (current[f] === w.to) set[f] = w.from;
    else kept.push(f);
  }
  if (LOCATION.some((f) => kept.includes(f)))
    for (const f of LOCATION)
      if (f in set) {
        delete set[f];
        kept.push(f);
      }
  return { set, kept, gps: "lat" in set || "lon" in set, place: "region_id" in set };
}

const SNAPSHOT = `c.lat::text AS lat, c.lon::text AS lon, c.location_source, c.location_accuracy_m::text AS location_accuracy_m,
  c.region_id::text AS region_id, c.taken_at::text AS taken_at`;

/** The found links' photos as they are now, inside the write-back's transaction. */
export async function snapshotFound(
  client: PoolClient,
  observationId: string,
  captureIds: string[],
): Promise<Map<string, CaptureValues & { link_writes: LinkWrites | null }>> {
  const res = await client.query<CaptureValues & { capture_id: string; link_writes: LinkWrites | null }>(
    `SELECT o.capture_id, o.link_writes, ${SNAPSHOT}
     FROM capture_inaturalist_observations o JOIN captures_all c ON c.id = o.capture_id
     WHERE o.inat_observation_id = $1 AND o.capture_id = ANY($2::uuid[]) AND o.source = 'inaturalist'
     FOR UPDATE OF c`,
    [observationId, captureIds],
  );
  return new Map(res.rows.map((r) => [r.capture_id, r]));
}

/** Records on each found link what the write-back just changed. */
export async function recordFoundWrites(
  client: PoolClient,
  observationId: string,
  before: Map<string, CaptureValues & { link_writes: LinkWrites | null }>,
): Promise<void> {
  if (before.size === 0) return;
  const after = await snapshotFound(client, observationId, [...before.keys()]);
  for (const [id, was] of before) {
    const now = after.get(id);
    const writes = now ? recordWrites(was, now, was.link_writes) : null;
    if (writes && writes !== was.link_writes)
      await client.query(`UPDATE capture_inaturalist_observations SET link_writes = $2 WHERE capture_id = $1`, [
        id,
        JSON.stringify(writes),
      ]);
  }
}

const CAST: Record<LinkField, string> = {
  lat: "numeric",
  lon: "numeric",
  location_source: "text",
  location_accuracy_m: "numeric",
  region_id: "uuid",
  taken_at: "timestamptz",
};

/** Unlinks photos found on iNaturalist (never ones Lifer sent): removes the link, restores what it
 *  wrote, rewrites the files, and remembers the pair so it's offered again but never linked by
 *  itself. Returns the pairs unlinked. */
export async function unlinkFound(
  userId: string,
  target: { captureIds?: string[]; observationId?: string },
): Promise<Array<{ captureId: string; observationId: string; kept: LinkField[] }>> {
  const done = await withTransaction(async (client) => {
    const rows = await client.query<
      CaptureValues & { capture_id: string; inat_observation_id: string; link_writes: LinkWrites | null }
    >(
      `SELECT o.capture_id, o.inat_observation_id, o.link_writes, ${SNAPSHOT}
       FROM capture_inaturalist_observations o JOIN captures_all c ON c.id = o.capture_id
       WHERE c.user_id = $1 AND o.source = 'inaturalist'
         AND ($2::uuid[] IS NULL OR o.capture_id = ANY($2::uuid[]))
         AND ($3::text IS NULL OR o.inat_observation_id = $3)
       FOR UPDATE OF c`,
      [userId, target.captureIds ?? null, target.observationId ?? null],
    );
    const out: Array<{
      captureId: string;
      observationId: string;
      kept: LinkField[];
      gps: boolean;
      place: boolean;
      restored: boolean;
    }> = [];
    for (const r of rows.rows) {
      const { set, kept, gps, place } = revertFor(r.link_writes, r);
      const fields = Object.keys(set) as LinkField[];
      if (fields.length > 0)
        await client.query(
          `UPDATE captures_all SET ${fields.map((f, i) => `${f} = $${i + 2}::${CAST[f]}`).join(", ")} WHERE id = $1`,
          [r.capture_id, ...fields.map((f) => set[f])],
        );
      await client.query(`DELETE FROM capture_inaturalist_observations WHERE capture_id = $1`, [r.capture_id]);
      await client.query(
        `INSERT INTO capture_inaturalist_not_matches (capture_id, inat_observation_id, kind) VALUES ($1, $2, 'unlinked')
         ON CONFLICT (capture_id, inat_observation_id) DO NOTHING`,
        [r.capture_id, r.inat_observation_id],
      );
      out.push({
        captureId: r.capture_id,
        observationId: r.inat_observation_id,
        kept,
        gps,
        place,
        restored: fields.length > 0,
      });
    }
    return out;
  });
  // The restored values reach the files like any edit; a removed pin is cleared from them.
  const limit = createLimiter(4);
  for (const d of done.filter((x) => x.restored))
    void limit(() =>
      syncCaptureXmpSidecarsLogged(userId, d.captureId, {
        replaceGps: d.gps || undefined,
        replacePlace: d.place || undefined,
      }),
    );
  const placed = done.filter((d) => d.place).map((d) => d.captureId);
  if (placed.length > 0) queueRecheck(userId, placed);
  return done.map(({ captureId, observationId, kept }) => ({ captureId, observationId, kept }));
}
