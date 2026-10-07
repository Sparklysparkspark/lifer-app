import { useState } from "react";
import { api } from "../../api/client";
import { useSettings, type Settings } from "../../hooks/useSettings";
import { errorMessage } from "../../lib/errorMessage";

type BooleanSettingKey = { [K in keyof Settings]-?: Settings[K] extends boolean ? K : never }[keyof Settings];

export interface ServerSetting {
  // null until GET /settings has answered.
  value: boolean | null;
  saving: boolean;
  error: string | null;
  save: (next: boolean) => Promise<void>;
}

/** One boolean from the shared settings cache, saved through its own PUT endpoint. */
export function useServerSetting(key: BooleanSettingKey, endpoint: string): ServerSetting {
  const { settings, setLocal } = useSettings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      await api.put(endpoint, { enabled: next });
      setLocal({ [key]: next } as Partial<Settings>);
    } catch (err) {
      setError(errorMessage(err, "Couldn't update this setting"));
    } finally {
      setSaving(false);
    }
  }

  return { value: settings ? settings[key] : null, saving, error, save };
}
