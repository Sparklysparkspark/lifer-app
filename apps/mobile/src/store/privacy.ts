// Sensitive species: the hub's list wins (its added/removed edits plus the by-default flag from
// each checklist). Locations of these are never shown, and a share asks first.
export interface SensitivePrefs {
  enabled: boolean;
  added: string[];
  removed: string[];
}

export const NO_SENSITIVE: SensitivePrefs = { enabled: true, added: [], removed: [] };

export function isSensitive(scientificName: string, byDefault: boolean, prefs: SensitivePrefs): boolean {
  if (!prefs.enabled) return false;
  if (prefs.removed.includes(scientificName)) return false;
  return byDefault || prefs.added.includes(scientificName);
}
