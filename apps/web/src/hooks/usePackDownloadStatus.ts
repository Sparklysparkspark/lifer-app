import { useEffect, useState } from "react";
import { api } from "../api/client";

export interface PackDownloadStatus {
  running: boolean;
  processed: number;
  total: number;
  currentPack: string | null;
  error: string | null;
  finishedAt: number | null;
  packIds: string[];
}

// Polled independently from wherever it's used, same reasoning as useMigrationStatus — the
// job's real state lives server-side (offlinePacks/routes.ts's downloadJob), so any mount can
// just ask for current truth instead of relying on whoever's local useState happened to start
// the download. This is what lets the Offline Data settings card and the floating updates
// banner both reflect an in-flight pack update even if it was started elsewhere, or survives
// the user navigating away from and back to whichever page shows it.
export function usePackDownloadStatus(pollMs = 1000): PackDownloadStatus | null {
  const [status, setStatus] = useState<PackDownloadStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await api.get<PackDownloadStatus>("/offline-packs/download/status");
        if (!cancelled) setStatus(res);
      } catch {
        if (!cancelled) setStatus(null);
      }
      // Poll faster while a job is actually running so progress feels live, and back off once
      // idle — no need to hit this endpoint every second when nothing's happening.
      if (!cancelled) timer = setTimeout(poll, status?.running ? pollMs : pollMs * 3);
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs]);

  return status;
}
