import { useState } from "react";

// For "how I like to browse" layout preferences (sort order, group-by, display toggles) that
// should survive leaving the page and even restarting Lifer — distinct from ephemeral content
// filters (search text, date range, region/taxon/tag, media type, RAW), which reset every time a
// page is entered so an old search/filter can never make a library look empty days later.
export function usePersistedState<T>(key: string, initialValue: T): [T, (value: T) => void] {
  const storageKey = `lifer:${key}`;
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw !== null ? (JSON.parse(raw) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });
  function update(value: T) {
    setState(value);
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      // Private-browsing/storage-disabled: the preference just doesn't survive a reload, no
      // need to surface an error for a purely cosmetic default.
    }
  }
  return [state, update];
}
