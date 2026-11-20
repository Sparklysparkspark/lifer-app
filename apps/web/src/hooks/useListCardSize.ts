import { usePersistedState } from "./usePersistedState";

export const LIST_CARD_SIZE = { min: 140, max: 360, step: 20, fallback: 200 } as const;

/** A card grid's minimum card width, remembered per page under its own key. */
export function useListCardSize(key: string): [number, (px: number) => void] {
  const [saved, setSaved] = usePersistedState<number>(key, LIST_CARD_SIZE.fallback);
  const width = Number.isFinite(saved) && saved >= LIST_CARD_SIZE.min ? saved : LIST_CARD_SIZE.fallback;
  return [width, setSaved];
}
