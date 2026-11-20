import type { Pool } from "pg";
import { groupByScientificName, type KeywordMatchedSpecies } from "@lifer/shared";

export { groupByScientificName, type KeywordMatchedSpecies };

// Shared by reimport.ts and /uploads/inspect. A keyword matches on the scientific name, the
// common name, an alias (common_name_aliases) or a superseded name (species_synonyms, migration
// 053). Exact, case-insensitive lower() equality rather than ILIKE, so a "%" or "_" in a keyword
// isn't a wildcard. Always returns the species' current names, never the matched alias.
export async function matchSpeciesByKeywords(pool: Pool, candidates: string[]): Promise<KeywordMatchedSpecies[]> {
  if (candidates.length === 0) return [];
  const lowerCandidates = candidates.map((c) => c.toLowerCase());
  const res = await pool.query<KeywordMatchedSpecies>(
    `SELECT DISTINCT s.id, s.scientific_name, s.common_name, s.taxon_class, s.family
     FROM species s
     WHERE lower(s.scientific_name) = ANY($1)
        OR lower(s.common_name) = ANY($1)
        OR EXISTS (SELECT 1 FROM unnest(s.common_name_aliases) a WHERE lower(a) = ANY($1))
        OR EXISTS (SELECT 1 FROM species_synonyms syn WHERE syn.species_id = s.id AND lower(syn.synonym_name) = ANY($1))
        OR lower(s.aba_code) = ANY($1)
        OR lower(s.ebird_code) = ANY($1)`,
    [lowerCandidates],
  );
  return res.rows;
}
