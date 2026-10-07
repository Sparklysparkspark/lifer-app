// Species names are catalog data, not interface text: they never go in the translation files,
// and scientific names are never translated. Every place that shows a species' common name goes
// through here, so localised names can arrive later without touching each page.
//
// Today: the catalog's English common name, or the scientific name when there is none.
// Later (see docs/docs/contributing/translating.md, "Species names"): per-language name packs
// downloaded with the catalog, looked up by the species' scientific name for the active locale,
// with the English common name as the fallback.
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

export interface NamedSpecies {
  commonName?: string | null;
  scientificName: string;
}

/** A localised common name for `locale`, or null. No name packs exist yet, so always null. */
function localisedCommonName(_species: NamedSpecies, _locale: string): string | null {
  return null;
}

/** The name to show for a species in `locale`: localised, then English common, then scientific. */
export function speciesDisplayName(species: NamedSpecies, locale = "en"): string {
  return localisedCommonName(species, locale) || species.commonName || species.scientificName;
}

/** speciesDisplayName for the active interface language, re-rendering when it changes. */
export function useSpeciesName(): (species: NamedSpecies) => string {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  return useCallback((species: NamedSpecies) => speciesDisplayName(species, locale), [locale]);
}
