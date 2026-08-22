import { useState } from "react";

// One shared localStorage key means dragging the slider on either SpeciesDetailPage's
// own-photo grid or GalleryPage's global gallery carries over to the other, rather than each
// page remembering its own separate preference.
const STORAGE_KEY = "lifer:photoGridThumbSize";
const DEFAULT_THUMB_SIZE_PX = 260;

export function usePhotoGridSize(): [number, (px: number) => void] {
  const [thumbSizePx, setThumbSizePx] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_THUMB_SIZE_PX;
    } catch {
      return DEFAULT_THUMB_SIZE_PX;
    }
  });

  function updateThumbSize(px: number) {
    setThumbSizePx(px);
    try {
      localStorage.setItem(STORAGE_KEY, String(px));
    } catch {
      // Private browsing or storage disabled — the slider still works this session, it just
      // won't be remembered next time.
    }
  }

  return [thumbSizePx, updateThumbSize];
}
