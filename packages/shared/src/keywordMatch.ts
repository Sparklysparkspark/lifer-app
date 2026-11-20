export interface KeywordMatchedSpecies {
  id: string;
  scientific_name: string;
  common_name: string | null;
  taxon_class: string | null;
  family: string | null;
}

// Groups matched rows by current scientific_name. More than one group means the keywords name
// different species (ambiguous), not just several aliases of one.
export function groupByScientificName(rows: KeywordMatchedSpecies[]): Map<string, KeywordMatchedSpecies[]> {
  const byName = new Map<string, KeywordMatchedSpecies[]>();
  for (const row of rows) {
    const list = byName.get(row.scientific_name) ?? [];
    list.push(row);
    byName.set(row.scientific_name, list);
  }
  return byName;
}
