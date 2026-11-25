// "spiders of Canada" -> a taxon query and a place query for the Add a list box. No LLM: the
// last "of", "in", "near", "around" or "from" splits the phrase, and iNaturalist's autocomplete
// resolves each side.

export interface ListPhrase {
  /** Words for taxa autocomplete; empty when nothing was typed before the place. */
  taxonQuery: string;
  /** Words for place search, null when the phrase names no place. */
  placeQuery: string | null;
  /** "near me" or "near here": a point around the user rather than a named place. */
  nearMe: boolean;
}

const SPLIT = /^(.*\S)\s+(?:of|in|near|around|from)\s+(\S.*)$/i;
const NEAR_ME = /^(?:me|here|my location)$/i;

export function parseListPhrase(input: string): ListPhrase {
  const text = input.trim().replace(/\s+/g, " ");
  const m = SPLIT.exec(text);
  if (!m) return { taxonQuery: text, placeQuery: null, nearMe: false };
  // Greedy, so "birds of prey of Canada" splits on the last "of".
  const place = m[2].trim();
  if (NEAR_ME.test(place)) return { taxonQuery: m[1].trim(), placeQuery: null, nearMe: true };
  return { taxonQuery: m[1].trim(), placeQuery: place, nearMe: false };
}

/** The query again without a plural ending, for a second try when the plain one finds nothing. */
export function singularQuery(query: string): string {
  const q = query.trim();
  if (/ies$/i.test(q)) return q.replace(/ies$/i, "y");
  if (/(ses|xes|ches|shes)$/i.test(q)) return q.replace(/es$/i, "");
  if (/[^s]s$/i.test(q)) return q.slice(0, -1);
  return q;
}

// Growth forms are not clades: iNaturalist reads "trees" as every vascular plant and finds nothing
// for "wildflowers", so the box asks for a group instead of adding a disappointing list.
const GROWTH_FORMS = new Set([
  "tree",
  "trees",
  "shrub",
  "shrubs",
  "bush",
  "bushes",
  "wildflower",
  "wildflowers",
  "weed",
  "weeds",
]);
export const isGrowthFormQuery = (query: string): boolean => GROWTH_FORMS.has(query.trim().toLowerCase());
