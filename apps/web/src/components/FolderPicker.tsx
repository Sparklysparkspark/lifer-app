import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { loadServerInfo } from "../hooks/useDeploymentMode";

interface DirectoryListing {
  // null for a self-hosted server's top level, which lists the allowed roots rather than a folder.
  path: string | null;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

// Tries the real native Finder dialog first (desktop shell talking to its own local API only;
// respects the OS's own hidden-file/recents/favorites conventions). Returns `undefined` when
// there's no usable native dialog: a plain browser tab, or the desktop shell connected to a
// remote server, whose filesystem a local dialog can't see. The caller should then fall back to
// <FolderBrowser>. Shared by the trip, reimport and storage folder pickers.
export async function pickFolderNative(): Promise<string | null | undefined> {
  if (!window.liferSetup) return undefined;
  const mode = await loadServerInfo()
    .then((info) => info.deploymentMode)
    .catch(() => null);
  if (mode !== "desktop") return undefined;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ directory: true });
  return typeof path === "string" ? path : null;
}

// Fallback-only browser: a plain HTTP directory listing of the API's own filesystem (GET
// /settings/browse-directory). A desktop API can list anything; a self-hosted server starts at
// its allowed roots (the library folder plus LIFER_LIBRARY_ROOTS), won't climb above them, and
// 403s anything outside, whose message is shown here.
export function FolderBrowser({ onChoose, onCancel }: { onChoose: (path: string) => void; onCancel: () => void }) {
  const [browsing, setBrowsing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once the server answered with a rooted top level, so an allowed root can step back to it.
  const [rooted, setRooted] = useState(false);

  useEffect(() => {
    browse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function browse(dirPath?: string) {
    setError(null);
    api
      .get<DirectoryListing>(`/settings/browse-directory${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ""}`)
      .then((res) => {
        if (res.path === null) setRooted(true);
        setBrowsing(res);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't browse that folder"));
  }

  if (!browsing) return error ? <p className="text-sm text-red-600">{error}</p> : <p className="text-sm text-muted">Loading…</p>;
  const currentPath = browsing.path;

  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <p className="truncate text-xs text-muted">{currentPath ?? "Folders Lifer can use"}</p>
      <div className="max-h-48 space-y-0.5 overflow-y-auto">
        {rooted && currentPath !== null && !browsing.parent && (
          <button onClick={() => browse()} className="block w-full rounded px-2 py-1 text-left text-sm text-muted hover:bg-surface-muted">
            .. (all folders)
          </button>
        )}
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
        <button
          type="button"
          onClick={() => currentPath && onChoose(currentPath)}
          disabled={currentPath === null}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
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
