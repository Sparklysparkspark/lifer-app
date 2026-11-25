// "spiders of Canada" -> a taxon query and a place query for the Add a list box. No LLM: the
// last "of", "in", "near", "around" or "from" splits the phrase, and iNaturalist's autocomplete
// resolves each side.
import { GROUP_TERMS, type GroupPredicate } from "./searchTaxonSynonyms.js";
import { normalizeWordForm } from "./searchTerms.js";

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
  // "birds of prey" is a group, not birds of a place called Prey.
  const m = groupTermFor(text) ? null : SPLIT.exec(text);
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

// Group words for naming a whole group only, the first being its name. Search keeps these as species nouns ("hawk" finds
// Red-tailed Hawk, not every hawk and eagle), so they stay out of GROUP_TERMS.
const LIST_GROUPS: Array<[string[], GroupPredicate]> = [
  [["hawks and eagles", "hawk", "eagle", "eagles and hawks"], { families: ["accipitridae"] }],
  [["falcons", "falcon"], { families: ["falconidae"] }],
  [
    ["warblers", "warbler"],
    {
      families: [
        "parulidae",
        "phylloscopidae",
        "sylviidae",
        "acrocephalidae",
        "locustellidae",
        "cettiidae",
        "cisticolidae",
      ],
    },
  ],
  // Leopard Cat is a small cat, hence the "cat" exclusion.
  [
    ["big cats", "big cat"],
    {
      families: ["felidae"],
      includeNameWords: ["lion", "tiger", "leopard", "jaguar", "cheetah", "cougar", "puma"],
      excludeNameWords: ["cat"],
    },
  ],
  [["sharks and rays", "shark and ray"], { classes: ["elasmobranchii"] }],
];
const LIST_TERMS = new Map(
  LIST_GROUPS.flatMap(([words, predicate]) => words.map((w) => [w, { label: words[0], predicate }] as const)),
);

/** The group a phrase's taxon words name in Lifer's own catalog ("raptors", "Owl", "hawks and
 *  eagles"), plural or not; undefined when it names none. */
export function groupTermFor(query: string): { label: string; predicate: GroupPredicate } | undefined {
  const text = query.trim().toLowerCase().replace(/\s+/g, " ");
  const singular = text.split(" ").map(normalizeWordForm).join(" ");
  return GROUP_TERMS.get(text) ?? LIST_TERMS.get(text) ?? GROUP_TERMS.get(singular) ?? LIST_TERMS.get(singular);
}
