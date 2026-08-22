import { useEffect, useState } from "react";
import { api } from "../api/client";

export interface MigrationStatus {
  running: boolean;
  serverUrl: string | null;
  migrated: number;
  skipped: number;
  failed: number;
  total: number;
  error: string | null;
  finishedAt: number | null;
}

// Polled independently from wherever it's used (the header indicator and the Settings
// migrate card both use this on their own), rather than threaded through app-wide state,
// since it's just a cheap read of in-memory job status (see settings/routes.ts's
// migrationJob) that any page can ask for on its own. 404s outside desktop mode — resolves
// to null there, same as everywhere else this pattern is used (see useDesktopMode).
export function useMigrationStatus(pollMs = 3000): MigrationStatus | null {
  const [status, setStatus] = useState<MigrationStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await api.get<MigrationStatus>("/settings/migrate-to-server/status");
        if (!cancelled) setStatus(res);
      } catch {
        if (!cancelled) setStatus(null);
      }
      if (!cancelled) timer = setTimeout(poll, pollMs);
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pollMs]);

  return status;
}
