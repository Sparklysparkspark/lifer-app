// Source: GBIF species vernacularNames API. License: CC0, same as GBIF Backbone itself.
// GBIF's `language` query param doesn't actually restrict results server-side (confirmed by
// hand — English and non-English names both come back regardless), so filtering to
// language === "eng" happens client-side here. Multiple English synonyms typically exist
// across checklists (Clements, IOC, ITIS, etc.) — preferring Clements/IOC since those are the
// standard birder references, falling back to whatever's first otherwise.

const PREFERRED_SOURCES = ["The Clements Checklist", "IOC World Bird List"];

interface VernacularNameResult {
  vernacularName: string;
  language: string;
  source?: string;
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
  const res = await fetch(url);
  if (!res.ok) return null;

  const data = (await res.json()) as { results: VernacularNameResult[] };
  const englishNames = data.results.filter((r) => r.language === "eng");
  if (englishNames.length === 0) return null;

  const preferred = englishNames.find((r) => r.source && PREFERRED_SOURCES.includes(r.source));
  return toTitleCase((preferred ?? englishNames[0]).vernacularName);
}
