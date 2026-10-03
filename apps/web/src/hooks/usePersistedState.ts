import { useState } from "react";

// For layout preferences (sort, group-by, display toggles) that survive restarts. Content filters
// deliberately don't persist, so an old filter can never make a library look empty later.
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
