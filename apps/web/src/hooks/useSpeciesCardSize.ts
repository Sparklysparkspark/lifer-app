import { usePersistedState } from "./usePersistedState";

// Separate key from usePhotoGridSize: species cards read well at a much narrower size range
// than bare photo tiles, so the two sliders shouldn't drag each other around.
const DEFAULT_CARD_MIN_WIDTH_PX = 160;

export function useSpeciesCardSize(): [number, (px: number) => void] {
  const [saved, setSaved] = usePersistedState<number>("speciesCardMinWidth", DEFAULT_CARD_MIN_WIDTH_PX);
  const cardMinWidth = Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_CARD_MIN_WIDTH_PX;
  return [cardMinWidth, setSaved];
}
