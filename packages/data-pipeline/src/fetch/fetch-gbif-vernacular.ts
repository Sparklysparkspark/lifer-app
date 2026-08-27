// Source: GBIF species vernacularNames API. License: CC0, same as GBIF Backbone itself.
// GBIF's `language` query param doesn't actually restrict results server-side (confirmed by
// hand — English and non-English names both come back regardless), so filtering to
// language === "eng" happens client-side here. Multiple English synonyms typically exist
// across checklists (Clements, IOC, ITIS, etc.) — preferring Clements/IOC since those are the
// standard birder references, falling back to whatever's first otherwise.

import { fetchWithRetry } from "../fetch-with-retry.js";

const PREFERRED_SOURCES = ["The Clements Checklist", "IOC World Bird List"];

interface VernacularNameResult {
  vernacularName: string;
  language: string;
  source?: string;
  preferred?: boolean;
}

// Fish (and anything else without a PREFERRED_SOURCES match) fall back to whatever's first —
// usually Catalogue of Life, which stores plenty of its own English vernacular names in
// plain lowercase (e.g. "panda", "coridoras" for Corydoras panda — 1,633 of 22,108 fish
// common names were affected). Clements/IOC bird names are already properly cased, so this
// is a no-op for them; only fixes the fallback path.
export function toTitleCase(name: string): string {
  return name.replace(/(^|[\s-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

export interface CommonNameResult {
  primary: string;
  // Every OTHER distinct English name GBIF knows for this species (e.g. Spotfin Frogfish is
  // also "Coin-Bearing Frogfish," "Ocellated Angler," "Big-Spot Angler," ...) — the exact
  // same englishNames list this function already fetches to pick the primary name, just not
  // thrown away afterward. Stored so a search for any real alias still finds the species
  // (see species.common_name_aliases's own migration comment), not only whichever single
  // name the tie-break logic above picked as primary.
  aliases: string[];
}

async function fetchEnglishVernacularNames(gbifKey: number): Promise<VernacularNameResult[]> {
  const url = `https://api.gbif.org/v1/species/${gbifKey}/vernacularNames?language=eng&limit=100`;
  const res = await fetchWithRetry(url, {});
  if (!res.ok) return [];
  const data = (await res.json()) as { results: VernacularNameResult[] };
  return data.results.filter((r) => r.language === "eng");
}

// GBIF splits vernacular names PER TAXON KEY, not merged across a synonym chain — confirmed
// on Antennatus nummifer (Spotfin Frogfish): its own key has exactly one English name, while
// "Coin-Bearing Frogfish," "Ocellated Fringed Fishing Frog," and others all sit on GBIF's own
// listed SYNONYM keys for the same species (Antennarius nummifer, Abantennarius nummifer,
// ...), not on the accepted key itself. Pulling those in too is what actually gets the full
// "also known as" list Wikipedia shows for a species — restricting to just the one key this
// species happens to be seeded under would silently miss most of it. Bounded cost: a species
// typically has a handful of synonym keys, not hundreds.
async function fetchSynonymKeys(gbifKey: number): Promise<number[]> {
  const url = `https://api.gbif.org/v1/species/${gbifKey}/synonyms?limit=50`;
  const res = await fetchWithRetry(url, {});
  if (!res.ok) return [];
  const data = (await res.json()) as { results: Array<{ key: number }> };
  return data.results.map((r) => r.key);
}

export async function fetchCommonNameWithAliases(gbifKey: number): Promise<CommonNameResult | null> {
  const synonymKeys = await fetchSynonymKeys(gbifKey);
  const nameLists = await Promise.all([gbifKey, ...synonymKeys].map(fetchEnglishVernacularNames));
  const englishNames = nameLists.flat();
  if (englishNames.length === 0) return null;

  const aliasesExcluding = (primary: string): string[] => {
    const seen = new Set([primary.toLowerCase()]);
    const aliases: string[] = [];
    for (const r of englishNames) {
      const cased = toTitleCase(r.vernacularName);
      const key = cased.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      aliases.push(cased);
    }
    return aliases;
  };

  // Clements/IOC take absolute priority for birds specifically — a deliberate, consistent
  // naming convention birders expect, not something to second-guess per species.
  const sourcePreferred = englishNames.find((r) => r.source && PREFERRED_SOURCES.includes(r.source));
  if (sourcePreferred) {
    const primary = toTitleCase(sourcePreferred.vernacularName);
    return { primary, aliases: aliasesExcluding(primary) };
  }

  // Multi-source consensus computed FIRST (not just as a fallback when nothing is
  // `preferred`) — several checklists independently agreeing on the same name is itself a
  // real signal that a single flag shouldn't automatically override. "Domestic Ass" (one
  // Catalogue of Life entry) beat "Donkey" (independently listed by ITIS, TAXREF, Catalogue
  // of Life, and two invasive-species registries) purely by coming first in GBIF's raw list
  // order — the mode across sources, not raw order, is what should decide a tie like this.
  const countsByName = new Map<string, number>();
  for (const r of englishNames) {
    const key = r.vernacularName.toLowerCase();
    countsByName.set(key, (countsByName.get(key) ?? 0) + 1);
  }
  // Ties happen — "Ass" and "Donkey" each have 5 independent sources for Equus asinus, no
  // count-based winner. Longer/fuller wins a tie ("Donkey" over "Ass", the same instinct as
  // "Grey Wolf" over "Wolf") — a plain first-in-list-order tiebreak has no basis for preferring
  // one over the other, so it isn't actually more "correct," just arbitrary.
  let bestName = englishNames[0].vernacularName;
  let bestCount = 0;
  for (const r of englishNames) {
    const count = countsByName.get(r.vernacularName.toLowerCase())!;
    if (count > bestCount || (count === bestCount && r.vernacularName.length > bestName.length)) {
      bestCount = count;
      bestName = r.vernacularName;
    }
  }

  // GBIF's own `preferred` flag (its checklists can flag one vernacular name as canonical
  // even across unrelated sources — e.g. "Spotted Eagle Ray" is preferred over "Maylan," a
  // regional name that otherwise won a plain first-result fallback purely by being early in
  // GBIF's raw list order) wins ONLY when no other name has strictly stronger independent
  // consensus — a single source's opinion (even IUCN's) shouldn't override several unrelated
  // checklists agreeing on something else. Confirmed on Antennarius maculatus: IUCN flags
  // "Clown Anglerfish" preferred (2 sources total), but "Warty Frogfish" is independently
  // used by 5 sources (TAXREF, ITIS, Catalogue of Life, IUCN itself as a non-preferred
  // alias, WoRMS) and matches the species' own Wikipedia article title — the preferred flag
  // was picking the minority name. When counts tie, the flagged name still wins (that's
  // exactly the Spotted Eagle Ray/Maylan case: both count 1, preferred breaks the tie).
  const gbifPreferred = englishNames.find((r) => r.preferred === true);
  if (gbifPreferred) {
    const preferredCount = countsByName.get(gbifPreferred.vernacularName.toLowerCase())!;
    if (preferredCount >= bestCount) {
      const primary = toTitleCase(gbifPreferred.vernacularName);
      return { primary, aliases: aliasesExcluding(primary) };
    }
  }

  const primary = toTitleCase(bestName);
  return { primary, aliases: aliasesExcluding(primary) };
}

/** Thin wrapper kept for every existing caller that only ever wanted the one primary name. */
export async function fetchCommonName(gbifKey: number): Promise<string | null> {
  const result = await fetchCommonNameWithAliases(gbifKey);
  return result?.primary ?? null;
}
