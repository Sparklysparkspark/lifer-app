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

export async function fetchCommonName(gbifKey: number): Promise<string | null> {
  const url = `https://api.gbif.org/v1/species/${gbifKey}/vernacularNames?language=eng&limit=100`;
  const res = await fetchWithRetry(url, {});
  if (!res.ok) return null;

  const data = (await res.json()) as { results: VernacularNameResult[] };
  const englishNames = data.results.filter((r) => r.language === "eng");
  if (englishNames.length === 0) return null;

  // Clements/IOC take priority for birds specifically — a deliberate, consistent naming
  // convention birders expect, not something to second-guess per species. Everything else
  // (fish, mammals, etc.) falls back to whichever entry GBIF's own API marks `preferred`
  // (its checklists can flag one vernacular name as canonical even across unrelated sources —
  // e.g. "Spotted Eagle Ray" is preferred over "Maylan," a regional name that otherwise won a
  // plain first-result fallback purely by being early in GBIF's raw list order), and only
  // truly falls back to the first raw result when nothing is marked preferred at all.
  const sourcePreferred = englishNames.find((r) => r.source && PREFERRED_SOURCES.includes(r.source));
  const gbifPreferred = englishNames.find((r) => r.preferred === true);
  if (sourcePreferred) return toTitleCase(sourcePreferred.vernacularName);
  if (gbifPreferred) return toTitleCase(gbifPreferred.vernacularName);

  // No explicit signal either way (common for non-bird taxa — e.g. donkey has zero `preferred`
  // flags at all) — several checklists independently agreeing on the same name is itself a
  // real signal that a plain first-result fallback ignores. "Domestic Ass" (one Catalogue of
  // Life entry) beat "Donkey" (independently listed by ITIS, TAXREF, Catalogue of Life, and
  // two invasive-species registries) purely by coming first in GBIF's raw list order — the
  // mode across sources, not raw order, is what should decide a tie like this.
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
  return toTitleCase(bestName);
}
