// Species names are catalog data, not interface text: they never go in the translation files,
// and scientific names are never translated. Every place that shows a species' common name goes
// through here, so localised names can arrive later without touching each page.
//
// Today: the catalog's English common name, or the scientific name when there is none.
// Later (see docs/docs/contributing/translating.md, "Species names"): per-language name packs
// downloaded with the catalog, looked up by the species' scientific name for the active locale,
// with the English common name as the fallback.
import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getSettingsState, subscribeSettings } from "../hooks/useSettings";
import {
  ALSO_SHOW_ORDER,
  alsoFromSecondLine,
  DEFAULT_SPECIES_NAME_PREFS,
  normaliseSpeciesNamePrefs,
  parseAlso,
  speciesDisplayName,
  speciesNameParts,
  type AlsoShow,
  type MainName,
  type NamePart,
  type NamedSpecies,
  type SpeciesNameParts,
  type SpeciesNamePrefs,
} from "@lifer/shared";

export {
  ALSO_SHOW_ORDER,
  DEFAULT_SPECIES_NAME_PREFS,
  normaliseSpeciesNamePrefs,
  speciesDisplayName,
  speciesNameParts,
  type AlsoShow,
  type MainName,
  type NamePart,
  type NamedSpecies,
  type SpeciesNameParts,
  type SpeciesNamePrefs,
};

/** The species' main name for the active language and View menu choice, re-rendering when either
 *  changes. */
export function useSpeciesName(prefs?: SpeciesNamePrefs): (species: NamedSpecies) => string {
  const parts = useSpeciesNameParts(prefs);
  return useCallback((species: NamedSpecies) => parts(species).primary.text, [parts]);
}

/** Tailwind classes for a name part: scientific names italic, codes compact uppercase. */
export function namePartClass(part: NamePart): string {
  return part.kind === "scientific" ? "italic" : part.kind === "code" ? "uppercase tracking-wide tabular-nums" : "";
}

// Per-browser, like the rest of the View menu, but shared live so every mounted view updates.
const MAIN_KEY = "lifer:speciesNameMain";
const ALSO_KEY = "lifer:speciesNameAlso";
// Earlier versions of the choice, read until a new one is saved.
const OLD_FIRST_KEY = "lifer:speciesNameFirst";
const OLD_SECOND_KEY = "lifer:speciesNameSecond";
const LEGACY_HIDE_SCIENTIFIC_KEY = "lifer:hideScientificName";
const listeners = new Set<() => void>();
let cached: SpeciesNamePrefs | null = null;

function readStored(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadPrefs(): SpeciesNamePrefs {
  const main = readStored(MAIN_KEY) ?? readStored(OLD_FIRST_KEY);
  const legacyHide = readStored(LEGACY_HIDE_SCIENTIFIC_KEY);
  const also =
    parseAlso(readStored(ALSO_KEY)) ??
    alsoFromSecondLine(readStored(OLD_SECOND_KEY)) ??
    (legacyHide === true || legacyHide === 1 ? [] : DEFAULT_SPECIES_NAME_PREFS.also);
  return { main: main === "scientific" ? "scientific" : "common", also };
}

function hasLocalPrefs(): boolean {
  return [MAIN_KEY, ALSO_KEY, OLD_FIRST_KEY, OLD_SECOND_KEY, LEGACY_HIDE_SCIENTIFIC_KEY].some(
    (key) => readStored(key) !== null,
  );
}

function getPrefs(): SpeciesNamePrefs {
  return (cached ??= loadPrefs());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Saves this browser's choice and returns the full result. */
export function setSpeciesNamePrefs(next: Partial<SpeciesNamePrefs>): SpeciesNamePrefs {
  const merged = { ...getPrefs(), ...next };
  cached = {
    main: merged.main === "scientific" ? "scientific" : "common",
    also: parseAlso(merged.also) ?? DEFAULT_SPECIES_NAME_PREFS.also,
  };
  try {
    localStorage.setItem(MAIN_KEY, JSON.stringify(cached.main));
    localStorage.setItem(ALSO_KEY, JSON.stringify(cached.also));
  } catch {
    // Storage disabled: the choice lasts until reload.
  }
  listeners.forEach((l) => l());
  return cached;
}

// A browser with no choice of its own takes the account's saved one once settings load.
subscribeSettings(() => {
  const server = normaliseSpeciesNamePrefs(getSettingsState().settings?.speciesNameDisplay);
  if (server && !hasLocalPrefs()) setSpeciesNamePrefs(server);
});

/** Re-reads storage; for tests that seed localStorage directly. */
export function resetSpeciesNamePrefsCache() {
  cached = null;
}

export function useSpeciesNamePrefs(): SpeciesNamePrefs {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}

/** speciesNameParts for the active language and this browser's View menu choice. Pass `prefs` to
 *  override it, as share pages do with the album owner's choice. */
export function useSpeciesNameParts(prefs?: SpeciesNamePrefs): (species: NamedSpecies) => SpeciesNameParts {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const stored = useSpeciesNamePrefs();
  const active = prefs ?? stored;
  return useCallback((species: NamedSpecies) => speciesNameParts(species, active, locale), [active, locale]);
}
