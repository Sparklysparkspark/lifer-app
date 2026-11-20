// Species names are catalog data, not interface text: they never go in the translation files,
// and scientific names are never translated. Every place that shows a species' common name goes
// through here, so localised names can arrive later without touching each page.
//
// Today: the catalog's English common name, or the scientific name when there is none.
// Later (see docs/docs/contributing/translating.md, "Species names"): per-language name packs
// downloaded with the catalog, looked up by the species' scientific name for the active locale,
// with the English common name as the fallback.

// API responses use either casing, so both shapes are accepted.
export type NamedSpecies =
  | { commonName?: string | null; scientificName: string; abaCode?: string | null; ebirdCode?: string | null }
  | { common_name?: string | null; scientific_name: string; aba_code?: string | null; ebird_code?: string | null };

interface Names {
  commonName: string | null;
  scientificName: string;
  abaCode: string | null;
  ebirdCode: string | null;
}

function namesOf(species: NamedSpecies): Names {
  return "scientificName" in species
    ? {
        commonName: species.commonName ?? null,
        scientificName: species.scientificName,
        abaCode: species.abaCode ?? null,
        ebirdCode: species.ebirdCode ?? null,
      }
    : {
        commonName: species.common_name ?? null,
        scientificName: species.scientific_name,
        abaCode: species.aba_code ?? null,
        ebirdCode: species.ebird_code ?? null,
      };
}

/** A localised common name for `locale`, or null. No name packs exist yet, so always null. */
function localisedCommonName(_scientificName: string, _locale: string): string | null {
  return null;
}

/** The name to show for a species in `locale`: localised, then English common, then scientific. */
export function speciesDisplayName(species: NamedSpecies, locale = "en"): string {
  const { commonName, scientificName } = namesOf(species);
  return localisedCommonName(scientificName, locale) || commonName || scientificName;
}

export type MainName = "common" | "scientific";
/** "other" is whichever of common/scientific isn't the main name. */
export type AlsoShow = "other" | "aba" | "ebird";
/** The second line's fixed order. */
export const ALSO_SHOW_ORDER: readonly AlsoShow[] = ["other", "aba", "ebird"];
export interface SpeciesNamePrefs {
  main: MainName;
  also: AlsoShow[];
}
export const DEFAULT_SPECIES_NAME_PREFS: SpeciesNamePrefs = { main: "common", also: ["other"] };

export interface NamePart {
  text: string;
  kind: "common" | "scientific" | "code";
}
export interface SpeciesNameParts {
  primary: NamePart;
  /** The second line, in ALSO_SHOW_ORDER; empty for none. */
  secondary: NamePart[];
}

/** The main name and the second line's parts. Codes a species doesn't have are left out. */
export function speciesNameParts(
  species: NamedSpecies,
  prefs: SpeciesNamePrefs = DEFAULT_SPECIES_NAME_PREFS,
  locale = "en",
): SpeciesNameParts {
  const names = namesOf(species);
  const common = localisedCommonName(names.scientificName, locale) || names.commonName;
  const scientific: NamePart = { text: names.scientificName, kind: "scientific" };
  const commonPart: NamePart | null = common ? { text: common, kind: "common" } : null;
  // No common name: scientific leads and is never repeated below it.
  const primary = prefs.main === "scientific" || !commonPart ? scientific : commonPart;
  const code = (text: string | null): NamePart | null => (text ? { text, kind: "code" } : null);
  const byChoice: Record<AlsoShow, NamePart | null> = {
    other: !commonPart ? null : primary === scientific ? commonPart : scientific,
    aba: code(names.abaCode),
    ebird: code(names.ebirdCode),
  };
  const secondary = ALSO_SHOW_ORDER.filter((k) => prefs.also.includes(k)).flatMap((k) => byChoice[k] ?? []);
  return { primary, secondary };
}

export function parseAlso(value: unknown): AlsoShow[] | null {
  return Array.isArray(value) ? ALSO_SHOW_ORDER.filter((k) => value.includes(k)) : null;
}

// The earlier single "Second line" choice, mapped exactly.
export function alsoFromSecondLine(value: unknown): AlsoShow[] | null {
  return value === "none" ? [] : value === "other" || value === "aba" || value === "ebird" ? [value] : null;
}

/** A saved choice in the current or the earlier ({first, second}) shape, or null if neither. */
export function normaliseSpeciesNamePrefs(value: unknown): SpeciesNamePrefs | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const main = o.main ?? o.first;
  const also = parseAlso(o.also) ?? alsoFromSecondLine(o.second);
  return (main === "common" || main === "scientific") && also ? { main, also } : null;
}
