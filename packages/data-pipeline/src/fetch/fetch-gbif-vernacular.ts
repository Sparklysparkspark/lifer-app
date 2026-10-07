// Source: GBIF species vernacularNames API. License: CC0, same as GBIF Backbone itself.
// GBIF's `language` param doesn't filter server-side, so English is filtered client-side.
// Clements/IOC are preferred for birds as the standard birder references.

import { fetchWithRetry } from "@lifer/core/lib/fetchWithRetry.js";

const PREFERRED_SOURCES = ["The Clements Checklist", "IOC World Bird List"];

interface VernacularNameResult {
  vernacularName: string;
  language: string;
  source?: string;
  preferred?: boolean;
}

// Fallback names (mostly Catalogue of Life) are often plain lowercase, so they get title-cased.
// Clements/IOC bird names are already cased.
export function toTitleCase(name: string): string {
  return name.replace(/(^|[\s-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

export interface CommonNameResult {
  primary: string;
  // Every other distinct English name GBIF knows for this species, stored so a search for any
  // alias still finds it (see species.common_name_aliases' migration).
  aliases: string[];
}

async function fetchEnglishVernacularNames(gbifKey: number): Promise<VernacularNameResult[]> {
  const url = `https://api.gbif.org/v1/species/${gbifKey}/vernacularNames?language=eng&limit=100`;
  const res = await fetchWithRetry(url, {});
  if (!res.ok) return [];
  const data = (await res.json()) as { results: VernacularNameResult[] };
  return data.results.filter((r) => r.language === "eng");
}

// GBIF attaches vernacular names per taxon key, not across a synonym chain, and most aliases
// sit on the synonym keys. Pulling those in gets the full "also known as" list. A species
// usually has only a handful of synonym keys.
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

  // Clements/IOC take absolute priority for birds: the naming convention birders expect.
  const sourcePreferred = englishNames.find((r) => r.source && PREFERRED_SOURCES.includes(r.source));
  if (sourcePreferred) {
    const primary = toTitleCase(sourcePreferred.vernacularName);
    return { primary, aliases: aliasesExcluding(primary) };
  }

  // Multi-source consensus comes first: several checklists agreeing on a name beats raw list
  // order or a single flag.
  const countsByName = new Map<string, number>();
  for (const r of englishNames) {
    const key = r.vernacularName.toLowerCase();
    countsByName.set(key, (countsByName.get(key) ?? 0) + 1);
  }
  // On a count tie, the longer, fuller name wins ("Grey Wolf" over "Wolf").
  let bestName = englishNames[0].vernacularName;
  let bestCount = 0;
  for (const r of englishNames) {
    const count = countsByName.get(r.vernacularName.toLowerCase())!;
    if (count > bestCount || (count === bestCount && r.vernacularName.length > bestName.length)) {
      bestCount = count;
      bestName = r.vernacularName;
    }
  }

  // GBIF's `preferred` flag wins only when no other name has strictly stronger consensus: one
  // source (even IUCN) shouldn't override several agreeing checklists. On a tie the flagged name wins.
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

/** Thin wrapper for callers that only need the primary name. */
export async function fetchCommonName(gbifKey: number): Promise<string | null> {
  const result = await fetchCommonNameWithAliases(gbifKey);
  return result?.primary ?? null;
}
