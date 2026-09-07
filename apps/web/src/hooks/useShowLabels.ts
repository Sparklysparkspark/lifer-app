import { useState } from "react";

// One shared localStorage key, same reasoning as usePhotoGridSize's own comment — toggling
// labels off on one grid (say, Trip detail) carries over to every other grid (Album detail,
// Trash, a share link) instead of each page remembering its own separate preference.
const STORAGE_KEY = "lifer:showPhotoLabels";

export function useShowLabels(): [boolean, (value: boolean) => void] {
  const [showLabels, setShowLabelsState] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });

  function setShowLabels(value: boolean) {
    setShowLabelsState(value);
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // Private browsing or storage disabled — the toggle still works this session, it just
      // won't be remembered next time.
    }
  }

  return [showLabels, setShowLabels];
}
