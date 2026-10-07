// Which photoless species recheck-null-photo-species.ts looks at again: enriched ones with no
// reference photo, not checked within recheckAfterDays, optionally limited to some countries'
// checklists or to every listed species (on a checklist or in a sea zone, what packs ship).
import type { Pool, PoolClient } from "pg";

export interface RecheckScope {
  countries: string[] | null;
  listedOnly: boolean;
  recheckAfterDays: number;
}

export async function selectSpeciesToRecheck(
  db: Pool | PoolClient,
  scope: RecheckScope,
): Promise<Array<{ id: string; scientific_name: string }>> {
  const res = await db.query<{ id: string; scientific_name: string }>(
    `SELECT s.id, s.scientific_name FROM species s
     WHERE s.enriched_at IS NOT NULL AND s.reference_photo IS NULL
       AND (s.photo_checked_at IS NULL OR s.photo_checked_at < now() - make_interval(days => $2::int))
       AND ($1::text[] IS NULL OR EXISTS (
         SELECT 1 FROM region_species rs JOIN regions r ON r.id = rs.region_id
         LEFT JOIN regions parent ON parent.id = r.parent_id
         WHERE rs.species_id = s.id AND (r.name = ANY($1) OR parent.name = ANY($1))))
       AND (NOT $3 OR EXISTS (SELECT 1 FROM region_species rs WHERE rs.species_id = s.id)
                   OR EXISTS (SELECT 1 FROM sea_zone_species z WHERE z.species_id = s.id))
     ORDER BY s.scientific_name`,
    [scope.countries, scope.recheckAfterDays, scope.listedOnly],
  );
  return res.rows;
}
