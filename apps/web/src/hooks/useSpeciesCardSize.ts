import { useState } from "react";

// Separate storage key from usePhotoGridSize — species cards (thumbnail + name label) read
// well at a much narrower size range than a bare photo tile, so the two sliders shouldn't drag
// each other around.
const STORAGE_KEY = "lifer:speciesCardMinWidth";
const DEFAULT_CARD_MIN_WIDTH_PX = 160;

export function useSpeciesCardSize(): [number, (px: number) => void] {
  const [cardMinWidth, setCardMinWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_CARD_MIN_WIDTH_PX;
    } catch {
      return DEFAULT_CARD_MIN_WIDTH_PX;
    }
  });

  function updateCardMinWidth(px: number) {
    setCardMinWidth(px);
    try {
      localStorage.setItem(STORAGE_KEY, String(px));
    } catch {
      // Private browsing or storage disabled — the slider still works this session, it just
      // won't be remembered next time.
    }
  }

  return [cardMinWidth, updateCardMinWidth];
}
