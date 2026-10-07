import { useEffect, useState } from "react";
import FormMessage from "../../components/FormMessage";
import { errorMessage } from "../../lib/errorMessage";
import { formatBytes, formatDate } from "../../lib/format";
import type { CacheInfo } from "../../lib/offlineCache";
import { tauriInvoke } from "../../lib/tauri";

/** The "Keep an offline cache" checkbox while connected to a server. Unticking deletes the cache. */
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
    <div className="space-y-1">
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={info.enabled}
          disabled={saving}
          onChange={(e) => void toggle(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Keep an offline cache. Low-res cover photos and your collected/seen status stay browsable, read-only, if this
          computer loses its connection to the server. Unticking deletes the cache.
        </span>
      </label>
      {info.enabled && (
        <p className="pl-6 text-xs text-muted">
          {info.syncedAt
            ? `Last synced ${formatDate(info.syncedAt, "dateTime")}: ${info.species} species, ${info.thumbs} covers, ${formatBytes(info.bytes)}.`
            : "Not synced yet. It syncs in the background while you're connected."}
        </p>
      )}
      <FormMessage error={error} />
    </div>
  );
}
