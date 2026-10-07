// Which species fetch-occurrence-stats.ts looks at, and how it records what it found. Every
// attempt that got an answer from GBIF is stamped in species_traits.occurrence_checked_at
// (migration 127), including "GBIF has no records" (count 0, no year), so a species is looked at
// again only once its stamp is older than recheckAfterDays.
import type { Pool, PoolClient } from "pg";
import type { OccurrenceStats } from "./occurrenceStats.js";

export interface OccurrenceTarget {
  species_id: string;
  gbif_key: number;
  scientific_name: string;
  /** What the run groups species by: the order name, else the catalog group. */
  group_name: string;
}

export interface TargetScope {
  /** Only species with no occurrence_count yet. */
  onlyMissing: boolean;
  /** Skip species stamped within this many days; 0 takes every species in scope. */
  recheckAfterDays: number;
  limit?: number | null;
}

export async function selectOccurrenceTargets(db: Pool | PoolClient, scope: TargetScope): Promise<OccurrenceTarget[]> {
  const res = await db.query<OccurrenceTarget & { gbif_key: string }>(
    `SELECT s.id AS species_id, s.gbif_key, s.scientific_name, COALESCE(s.taxon_order, s.taxon_class) AS group_name
       FROM species s
       JOIN species_traits st ON st.species_id = s.id
      WHERE s.gbif_key IS NOT NULL
        AND (NOT $1 OR st.occurrence_count IS NULL)
        AND ($2::int = 0 OR st.occurrence_checked_at IS NULL
             OR st.occurrence_checked_at < now() - make_interval(days => $2::int))
      ORDER BY group_name, s.family NULLS LAST, s.scientific_name
      LIMIT $3`,
    [scope.onlyMissing, scope.recheckAfterDays, scope.limit ?? null],
  );
  return res.rows.map((r) => ({ ...r, gbif_key: Number(r.gbif_key) }));
}

export interface StatsUpdate {
  speciesId: string;
  stats: OccurrenceStats;
}

/** Writes counts and last years and stamps them as checked now. */
export async function saveOccurrenceStats(db: Pool | PoolClient, updates: StatsUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  await db.query(
    `UPDATE species_traits st
        SET occurrence_count = v.count, last_occurrence_year = v.last_year, occurrence_checked_at = now()
       FROM unnest($1::uuid[], $2::int[], $3::int[]) AS v(species_id, count, last_year)
      WHERE st.species_id = v.species_id`,
    [updates.map((u) => u.speciesId), updates.map((u) => u.stats.count), updates.map((u) => u.stats.lastYear)],
  );
}

/** Stamps species GBIF answered with an error that won't go away by retrying (a 4xx), leaving
 *  their stats as they were, so they wait like any other checked species. */
export async function stampOccurrenceChecked(db: Pool | PoolClient, speciesIds: string[]): Promise<void> {
  if (speciesIds.length === 0) return;
  await db.query(`UPDATE species_traits SET occurrence_checked_at = now() WHERE species_id = ANY($1::uuid[])`, [
    speciesIds,
  ]);
}
