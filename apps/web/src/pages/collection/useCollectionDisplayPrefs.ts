import { usePersistedState } from "../../hooks/usePersistedState";
import { useSpeciesCardSize } from "../../hooks/useSpeciesCardSize";

// Stored as "1"/"0", which parse to numbers.
function usePersistedFlag(key: string): [boolean, (value: boolean) => void] {
  const [raw, setRaw] = usePersistedState<boolean | number>(key, false);
  return [raw === true || raw === 1, (value: boolean) => setRaw(value)];
}

// Cosmetic, per-browser layout preferences for the collection grid.
export function useCollectionDisplayPrefs() {
  const [cardMinWidth, setCardMinWidth] = useSpeciesCardSize();
  // Hides every badge in a card's status row.
  const [hideLabels, setHideLabels] = usePersistedFlag("hideLabels");
  // Photo-only cards.
  const [hideNames, setHideNames] = usePersistedFlag("hideNames");
  const [hideScientificName, setHideScientificName] = usePersistedFlag("hideScientificName");
  // One global preference, not per region.
  const [mapCollapsed, setMapCollapsed] = usePersistedFlag("collectionMapCollapsed");
  return {
    cardMinWidth,
    setCardMinWidth,
    hideLabels,
    setHideLabels,
    hideNames,
    setHideNames,
    hideScientificName,
    setHideScientificName,
    mapCollapsed,
    toggleMapCollapsed: () => setMapCollapsed(!mapCollapsed),
  };
}

export type CollectionDisplayPrefs = ReturnType<typeof useCollectionDisplayPrefs>;
