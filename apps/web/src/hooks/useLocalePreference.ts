import { useEffect, useState } from "react";
import { api } from "../api/client";
import {
  applyLocalePreference,
  cacheLocalePreference,
  readCachedLocalePreference,
  type LocalePreference,
} from "../i18n";
import { errorMessage } from "../lib/errorMessage";
import i18n from "../i18n";
import { useSettings } from "./useSettings";

// The account's language lives in GET /settings (users.locale, null = automatic). localStorage
// keeps a copy so the first paint is already in the right language; the account wins when they differ.

/** Applies the account's language once settings load, if it differs from this browser's copy. */
export function useLocaleSync(): void {
  const { settings } = useSettings();
  const fromAccount = settings ? (settings.locale ?? "auto") : null;
  useEffect(() => {
    if (fromAccount === null || fromAccount === readCachedLocalePreference()) return;
    cacheLocalePreference(fromAccount);
    void applyLocalePreference(fromAccount);
  }, [fromAccount]);
}

/** The language preference for Settings > General, saved to the account. */
export function useLocalePreference(): {
  preference: LocalePreference;
  saving: boolean;
  error: string | null;
  setPreference: (next: LocalePreference) => Promise<void>;
} {
  const { settings, setLocal } = useSettings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preference = settings ? (settings.locale ?? "auto") : readCachedLocalePreference();

  async function setPreference(next: LocalePreference) {
    setSaving(true);
    setError(null);
    // Switch at once; the account copy follows.
    cacheLocalePreference(next);
    await applyLocalePreference(next);
    try {
      const saved = await api.put<{ locale: string | null }>("/settings/locale", {
        locale: next === "auto" ? null : next,
      });
      setLocal({ locale: saved.locale });
    } catch (err) {
      setError(errorMessage(err, i18n.t("settings.general.language.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return { preference, saving, error, setPreference };
}
