// Re-files your photos when a species they're under has been split. The old entry often stays
// valid for part of its range, so a photo left on it could show a wrong tier or Ghost.
//
// Each photo is settled by where it was taken, against checklists from its place up to the country:
// - the old species is still listed there, lives at sea, or you kept the old name: it stays;
// - exactly one new species is listed there: it moves, as if changed by hand;
// - otherwise it stays, and the card says "Name changed" and asks which it is.
// Runs after a catalog update and after a pack install.
import type { PoolClient } from "pg";
import { MEDIA_CACHE_BUST } from "@lifer/core/config.js";
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { reassignCaptureSpecies } from "../captures/routes.js";

type Queryable = Pick<PoolClient, "query">;

// For every capture on a split species: the regions its place sits in, from its own up to the
// country, then whether the old species and which of the new ones are listed in any of them.
// Continents and the world are left out: their lists hold everything in them.
const SPLIT_DECISIONS_SQL = `
  WITH RECURSIVE cap AS (
    SELECT c.id AS capture_id, c.user_id, c.species_id, c.region_id
    FROM captures c
    WHERE c.species_id IN (SELECT parent_species_id FROM species_splits)
      AND ($1::uuid IS NULL OR c.user_id = $1)
  ),
  up AS (
    SELECT cap.capture_id, r.id AS region_id, r.parent_id, 0 AS depth
    FROM cap JOIN regions r ON r.id = cap.region_id
    UNION ALL
    SELECT up.capture_id, r.id, r.parent_id, up.depth + 1
    FROM up JOIN regions r ON r.id = up.parent_id
    WHERE up.depth < 12
  ),
  places AS (
    SELECT up.capture_id, up.region_id FROM up
    JOIN regions r ON r.id = up.region_id
    LEFT JOIN regions p ON p.id = r.parent_id
    WHERE r.parent_id IS NOT NULL AND p.parent_id IS NOT NULL
  )
  SELECT cap.capture_id, cap.user_id, cap.species_id,
    (EXISTS (SELECT 1 FROM species_split_kept k WHERE k.capture_id = cap.capture_id)
     OR EXISTS (SELECT 1 FROM places pl JOIN region_species rs ON rs.region_id = pl.region_id
                WHERE pl.capture_id = cap.capture_id AND rs.species_id = cap.species_id)
     OR EXISTS (SELECT 1 FROM sea_zone_species z WHERE z.species_id = cap.species_id)) AS still_valid,
    ARRAY(SELECT DISTINCT sp.daughter_species_id FROM species_splits sp
          JOIN region_species rs ON rs.species_id = sp.daughter_species_id
          JOIN places pl ON pl.region_id = rs.region_id AND pl.capture_id = cap.capture_id
          WHERE sp.parent_species_id = cap.species_id) AS listed_here
  FROM cap`;

interface SplitDecision {
  capture_id: string;
  user_id: string;
  species_id: string;
  still_valid: boolean;
  listed_here: string[];
}

export interface SplitResolution {
  moved: number;
  /** Captures still waiting for their owner to pick which new species they are. */
  unresolved: number;
}

/** Re-files every capture (or one user's) that a split can settle by place. Call outside any
 *  transaction: moving a photo moves its files. */
export async function resolveSpeciesSplits(userId: string | null = null): Promise<SplitResolution> {
  const decisions = await pool.query<SplitDecision>(SPLIT_DECISIONS_SQL, [userId]);
  let moved = 0;
  let unresolved = 0;
  for (const d of decisions.rows) {
    if (d.still_valid) continue;
    if (d.listed_here.length !== 1) {
      unresolved++;
      continue;
    }
    try {
      const result = await reassignCaptureSpecies(d.user_id, d.capture_id, d.listed_here[0], log);
      if (result.ok) moved++;
      else unresolved++;
    } catch (err) {
      // One photo's files failing to move shouldn't stop the rest; it's left to pick by hand.
      log.error({ err, captureId: d.capture_id }, "Couldn't re-file a photo after a species split");
      unresolved++;
    }
  }
  if (moved > 0 || unresolved > 0) log.info({ moved, unresolved }, "Re-filed photos after species splits");
  return { moved, unresolved };
}

/** Species of this user's with photos a split couldn't settle, for the "Name changed" badge. */
export async function speciesWithUnresolvedSplits(db: Queryable, userId: string, speciesIds: string[]): Promise<Set<string>> {
  if (speciesIds.length === 0) return new Set();
  const candidates = await db.query<{ parent_species_id: string }>(
    `SELECT DISTINCT parent_species_id FROM species_splits WHERE parent_species_id = ANY($1::uuid[])`,
    [speciesIds],
  );
  if (candidates.rows.length === 0) return new Set();
  const decisions = await db.query<SplitDecision>(SPLIT_DECISIONS_SQL, [userId]);
  const wanted = new Set(candidates.rows.map((r) => r.parent_species_id));
  return new Set(decisions.rows.filter((d) => wanted.has(d.species_id) && !d.still_valid).map((d) => d.species_id));
}

/** Marks cards whose species has photos waiting on a split, and drops the tags that no longer fit
 *  it (tiers, Ghost, Lost, Endemic, Vagrant): they describe the old species' narrower meaning, not
 *  your photo. */
export async function markNameChanged<T extends { speciesId: string }>(userId: string, items: T[]): Promise<Array<T & { nameChanged: boolean }>> {
  const pending = await speciesWithUnresolvedSplits(pool, userId, items.map((i) => i.speciesId));
  return items.map((item) =>
    pending.has(item.speciesId)
      ? {
          ...item,
          nameChanged: true,
          endemic: false,
          vagrant: false,
          isGhost: false,
          isLost: false,
          rediscoveredGhost: false,
          rediscoveredLost: false,
          tier: null,
          localTier: null,
          tierReason: null,
          localTierReason: null,
        }
      : { ...item, nameChanged: false },
  );
}

/** What a "Name changed" card offers: the new species, and this user's photos still to settle. */
export async function splitOptions(userId: string, speciesId: string) {
  const daughters = await pool.query<{ id: string; scientific_name: string; common_name: string | null; reference_photo: string | null; has_thumb: boolean }>(
    `SELECT s.id, s.scientific_name, s.common_name, s.reference_photo, (s.reference_thumb_path IS NOT NULL) AS has_thumb
     FROM species_splits sp JOIN species s ON s.id = sp.daughter_species_id
     WHERE sp.parent_species_id = $1
     ORDER BY s.common_name NULLS LAST, s.scientific_name`,
    [speciesId],
  );
  const decisions = await pool.query<SplitDecision>(SPLIT_DECISIONS_SQL, [userId]);
  const captureIds = decisions.rows.filter((d) => d.species_id === speciesId && !d.still_valid).map((d) => d.capture_id);
  return {
    captureIds,
    species: daughters.rows.map((d) => ({
      id: d.id,
      scientificName: d.scientific_name,
      commonName: d.common_name,
      photoUrl: d.has_thumb ? `/api/species/${d.id}/reference-photo/thumb?v=${MEDIA_CACHE_BUST}` : d.reference_photo,
    })),
  };
}
