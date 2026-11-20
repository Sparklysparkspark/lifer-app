import { usePersistedState } from "../../hooks/usePersistedState";
import { useSpeciesCardSize } from "../../hooks/useSpeciesCardSize";
import { api } from "../../api/client";
import { setLocalSettings } from "../../hooks/useSettings";
import { ignore } from "../../lib/ignore";
import { setSpeciesNamePrefs, useSpeciesNamePrefs, type SpeciesNamePrefs } from "../../lib/speciesName";

// Stored as "1"/"0", which parse to numbers.
export function usePersistedFlag(key: string): [boolean, (value: boolean) => void] {
  const [raw, setRaw] = usePersistedState<boolean | number>(key, false);
  return [raw === true || raw === 1, (value: boolean) => setRaw(value)];
}

// Instant in this browser; the account copy is what the owner's share pages use.
export function saveSpeciesNames(next: Partial<SpeciesNamePrefs>) {
  const saved = setSpeciesNamePrefs(next);
  setLocalSettings({ speciesNameDisplay: saved });
  api.put("/settings/species-name-display", saved).catch(ignore("Saving the species name choice failed"));
}

/** Where a photo must be taken for its species to count as photographed on a region's checklist. */
export type PhotographedIn = "anywhere" | "country" | "province";

// Cosmetic, per-browser layout preferences for the collection grid.
export function useCollectionDisplayPrefs() {
  const [cardMinWidth, setCardMinWidth] = useSpeciesCardSize();
  // Hides every badge in a card's status row.
  const [hideLabels, setHideLabels] = usePersistedFlag("hideLabels");
  // Photo-only cards.
  const [hideNames, setHideNames] = usePersistedFlag("hideNames");
  // Shared with every view that names a species, so it lives in speciesName.ts.
  const speciesNames = useSpeciesNamePrefs();
  // One global preference, not per region.
  const [mapCollapsed, setMapCollapsed] = usePersistedFlag("collectionMapCollapsed");
  // Stored as hidden so the default, shown, needs nothing saved.
  const [mapPinsHidden, setMapPinsHidden] = usePersistedFlag("collectionMapPinsHidden");
  // Off by default: not-yet-photographed covers stay grey.
  const [uncollectedColour, setUncollectedColour] = usePersistedFlag("uncollectedColour");
  // Saved as a level, not a place, so it follows the page: a country page reads "province" as its country.
  const [photographedIn, setPhotographedIn] = usePersistedState<PhotographedIn>("photographedIn", "anywhere");
  return {
    cardMinWidth,
    setCardMinWidth,
    hideLabels,
    setHideLabels,
    hideNames,
    setHideNames,
    uncollectedColour,
    setUncollectedColour,
    speciesNames,
    setSpeciesNames: saveSpeciesNames,
    mapCollapsed,
    toggleMapCollapsed: () => setMapCollapsed(!mapCollapsed),
    showMapPins: !mapPinsHidden,
    setShowMapPins: (on: boolean) => setMapPinsHidden(!on),
    photographedIn,
    setPhotographedIn,
  };
}

export type CollectionDisplayPrefs = ReturnType<typeof useCollectionDisplayPrefs>;
