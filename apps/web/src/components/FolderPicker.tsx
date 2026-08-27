import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";

interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

// Tries the real native Finder dialog first (desktop app only — respects the OS's own
// hidden-file/recents/favorites conventions, so there's no "why is it showing dotfiles"
// browser-UX to maintain). Returns `undefined` when Tauri isn't available at all (a
// self-hosted single-user server/Docker deployment accessed from a plain browser, where
// there's no native dialog to call) — the caller should fall back to <FolderBrowser> in that
// case. Shared by TripsPage's create flow and TripDetailPage's "Relocate folder" action.
export async function pickFolderNative(): Promise<string | null | undefined> {
  if (!window.liferSetup) return undefined;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ directory: true });
  return typeof path === "string" ? path : null;
}

// Fallback-only browser: a plain HTTP directory listing of whatever the API's own filesystem
// can see (GET /settings/browse-directory, same as StorageLocationSection in
// SettingsPage.tsx) — works identically for the desktop app and a self-hosted server.
export function FolderBrowser({ onChoose, onCancel }: { onChoose: (path: string) => void; onCancel: () => void }) {
  const [browsing, setBrowsing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    browse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function browse(dirPath?: string) {
    setError(null);
    api
      .get<DirectoryListing>(`/settings/browse-directory${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ""}`)
      .then(setBrowsing)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't browse that folder"));
  }

  if (!browsing) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <p className="truncate text-xs text-muted">{browsing.path}</p>
      <div className="max-h-48 space-y-0.5 overflow-y-auto">
        {browsing.parent && (
          <button onClick={() => browse(browsing.parent!)} className="block w-full rounded px-2 py-1 text-left text-sm text-muted hover:bg-surface-muted">
            .. (up one level)
          </button>
        )}
        {browsing.entries.map((entry) => (
          <button
            key={entry.path}
            onClick={() => browse(entry.path)}
            className="block w-full rounded px-2 py-1 text-left text-sm text-ink hover:bg-surface-muted"
          >
            {entry.name}
          </button>
        ))}
      </div>
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={() => onChoose(browsing.path)} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg">
          Use this folder
        </button>
        <button type="button" onClick={onCancel} className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted">
          Cancel
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
