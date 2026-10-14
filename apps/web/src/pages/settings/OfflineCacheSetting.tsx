import { useEffect, useState } from "react";
import FormMessage from "../../components/FormMessage";
import Switch from "../../components/Switch";
import { errorMessage } from "../../lib/errorMessage";
import { formatBytes, formatDate } from "../../lib/format";
import type { CacheInfo } from "../../lib/offlineCache";
import { tauriInvoke } from "../../lib/tauri";
import { SettingRow } from "./shared";

/** The offline cache switch while connected to a server. Turning it off deletes the cache. */
export default function OfflineCacheSetting() {
  const [info, setInfo] = useState<CacheInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invoke = tauriInvoke();

  useEffect(() => {
    if (!invoke) return;
    (invoke("offline_cache_info") as Promise<CacheInfo>).then(setInfo).catch(() => setInfo(null));
  }, [invoke]);

  // A desktop app from before the offline cache has no such command: show nothing.
  if (!invoke || !info) return null;

  async function toggle(enabled: boolean) {
    setError(null);
    setSaving(true);
    try {
      await invoke!("set_offline_cache", { enabled });
      setInfo((await invoke!("offline_cache_info")) as CacheInfo);
    } catch (err) {
      setError(errorMessage(err, "Couldn't change the offline cache"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingRow
      label="Offline cache"
      description={
        info.enabled
          ? info.syncedAt
            ? `Last synced ${formatDate(info.syncedAt, "dateTime")}: ${info.species} species, ${info.thumbs} covers, ${formatBytes(info.bytes)}.`
            : "Not synced yet. It syncs in the background while you're connected."
          : "Keeps covers and collected status browsable if the server is unreachable. Turning it off deletes the cache."
      }
      control={
        <Switch label="Offline cache" checked={info.enabled} disabled={saving} onChange={(next) => void toggle(next)} />
      }
    >
      {error && <FormMessage error={error} />}
    </SettingRow>
  );
}
