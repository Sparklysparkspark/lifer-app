import type { Pool } from "pg";

export interface KeywordMatchedSpecies {
  id: string;
  scientific_name: string;
  common_name: string | null;
  taxon_class: string | null;
  family: string | null;
}

// Shared by reimport.ts (matching a naturetag-style folder's embedded keywords) and
// /uploads/inspect (matching a single new upload's embedded keywords) — a tagged photo's
// keyword doesn't have to be the full scientific name to match: the primary common name, any
// of its known aliases (common_name_aliases), or a superseded scientific name
// (species_synonyms, migration 053) are all enough. Case-insensitive via lower() equality, not
// ILIKE, since these are exact-match candidates rather than patterns — a stray "%"/"_" in a
// real keyword string shouldn't be read as a SQL wildcard. Always returns the species' own
// current scientific_name/common_name, never the matched-on alias or stale synonym string.
export async function matchSpeciesByKeywords(pool: Pool, candidates: string[]): Promise<KeywordMatchedSpecies[]> {
  if (candidates.length === 0) return [];
  const lowerCandidates = candidates.map((c) => c.toLowerCase());
  const res = await pool.query<KeywordMatchedSpecies>(
    `SELECT DISTINCT s.id, s.scientific_name, s.common_name, s.taxon_class, s.family
     FROM species s
     WHERE lower(s.scientific_name) = ANY($1)
        OR lower(s.common_name) = ANY($1)
        OR EXISTS (SELECT 1 FROM unnest(s.common_name_aliases) a WHERE lower(a) = ANY($1))
        OR EXISTS (SELECT 1 FROM species_synonyms syn WHERE syn.species_id = s.id AND lower(syn.synonym_name) = ANY($1))`,
    [lowerCandidates],
  );
  return res.rows;
}

// Groups matched rows by their current scientific_name — more than one group means the
// keywords collided across genuinely distinct species (ambiguous), not just multiple alias
// rows for the same one.
export function groupByScientificName(rows: KeywordMatchedSpecies[]): Map<string, KeywordMatchedSpecies[]> {
  const byName = new Map<string, KeywordMatchedSpecies[]>();
  for (const row of rows) {
    const list = byName.get(row.scientific_name) ?? [];
    list.push(row);
    byName.set(row.scientific_name, list);
  }
  return byName;
}
