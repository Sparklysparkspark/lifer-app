import { useEffect } from "react";
import type { CollectionItem } from "@lifer/shared";
import { api } from "../api/client";
import { tauriInvoke } from "../lib/tauri";
import { isSyncDue, makeBrowserThumb, syncOfflineCache, type CacheInfo } from "../lib/offlineCache";

// How often to check whether the offline cache is due a sync (lib/offlineCache.ts decides).
const CHECK_EVERY_MS = 5 * 60_000;

/** Keeps the desktop app's offline cache of this user's collection fresh while connected to a
 *  server. Renders nothing; does nothing in a browser, in local mode, or with the option off. */
export default function OfflineCacheSync({ userId }: { userId: string | null }) {
  useEffect(() => {
    const invoke = tauriInvoke();
    if (!invoke || !userId) return;
    let cancelled = false;
    let running = false;
    let firstRun = true;

    async function tick() {
      if (running || cancelled || !invoke || !userId) return;
      running = true;
      try {
        // Errors (an older desktop app without the command, an untrusted page) mean: don't sync.
        const info = (await invoke("offline_cache_info").catch(() => null)) as CacheInfo | null;
        if (!info?.enabled || !info.fromServer) return;
        if (!isSyncDue(info.syncedAt, Date.now(), firstRun)) return;
        await syncOfflineCache({
          invoke,
          userId,
          fetchCollection: async () => (await api.get<{ items: CollectionItem[] }>("/collection")).items,
          makeThumb: makeBrowserThumb,
        });
      } catch (err) {
        console.warn("[lifer] offline cache sync failed", err);
      } finally {
        running = false;
        firstRun = false;
      }
    }

    void tick();
    const timer = window.setInterval(() => void tick(), CHECK_EVERY_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [userId]);

  return null;
}
