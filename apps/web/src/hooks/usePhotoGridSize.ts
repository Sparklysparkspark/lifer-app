import { usePersistedState } from "./usePersistedState";

// One shared key so the slider on SpeciesDetailPage's photo grid and GalleryPage carry over
// to each other.
const DEFAULT_THUMB_SIZE_PX = 260;

export function usePhotoGridSize(): [number, (px: number) => void] {
  const [saved, setSaved] = usePersistedState<number>("photoGridThumbSize", DEFAULT_THUMB_SIZE_PX);
  const thumbSizePx = Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_THUMB_SIZE_PX;
  return [thumbSizePx, setSaved];
}
