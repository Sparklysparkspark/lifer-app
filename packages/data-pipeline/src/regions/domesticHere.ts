// Which species count as domestic in a region: farm animals that are domestic everywhere
// (species_traits.domestic, from MDD), and domestic breeds of a wild species (the chicken of Red
// Junglefowl) in a country where iNaturalist lists that species as introduced. A domestic species
// is never a vagrant and gets no local tier; in its native range the wild bird keeps both.
import type { Pool, PoolClient } from "pg";
import { loadSpeciesCorrections, type SpeciesCorrection } from "../pipeline/speciesCorrections.js";

let names: string[] | null = null;

/** Scientific names marked domesticWhereIntroduced in species-corrections.json. */
export function domesticBreedNames(corrections?: SpeciesCorrection[]): string[] {
  if (corrections) return corrections.filter((c) => c.domesticWhereIntroduced).map((c) => c.scientificName);
  names ??= domesticBreedNames(loadSpeciesCorrections());
  return names;
}

/** Species domestic in `regionId`'s country, by id with their GBIF keys. */
export async function domesticSpeciesIn(
  db: Pool | PoolClient,
  regionId: string,
  breeds: string[] = domesticBreedNames(),
): Promise<{ ids: Set<string>; gbifKeys: Set<number> }> {
  const res = await db.query<{ id: string; gbif_key: string | null }>(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, sovereignty_group, external_codes, 0 AS depth FROM regions WHERE id = $1
       UNION ALL
       SELECT r.id, r.parent_id, r.sovereignty_group, r.external_codes, up.depth + 1
         FROM regions r JOIN up ON r.id = up.parent_id
        WHERE up.sovereignty_group IS NULL AND up.depth < 6
     ),
     -- The country is the first region up with a sovereignty group; its first code is its ISO3.
     country AS (
       SELECT external_codes[1] AS iso3 FROM up
        WHERE sovereignty_group IS NOT NULL AND external_codes[1] ~ '^[A-Z]{3}$'
        ORDER BY depth LIMIT 1
     )
     SELECT s.id, s.gbif_key::text FROM species s JOIN species_traits t ON t.species_id = s.id WHERE t.domestic
     UNION
     SELECT s.id, s.gbif_key::text FROM species s
       JOIN species_nonnative_countries snc ON snc.species_id = s.id
       JOIN country c ON c.iso3 = snc.country_iso3
      WHERE s.scientific_name = ANY($2::text[])`,
    [regionId, breeds],
  );
  return {
    ids: new Set(res.rows.map((r) => r.id)),
    gbifKeys: new Set(res.rows.filter((r) => r.gbif_key != null).map((r) => Number(r.gbif_key))),
  };
}
