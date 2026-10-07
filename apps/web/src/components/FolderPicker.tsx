import { useEffect, useState } from "react";
import { api } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import Button from "./Button";
import FormMessage from "./FormMessage";

interface DirectoryListing {
  // null for a self-hosted server's top level, which lists the allowed roots rather than a folder.
  path: string | null;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

// Directory listing of the API's filesystem (GET /settings/browse-directory). A server starts at
// its allowed roots and refuses anything outside them, with the message shown here.
export function FolderBrowser({ onChoose, onCancel }: { onChoose: (path: string) => void; onCancel: () => void }) {
  const [browsing, setBrowsing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once the server answered with a rooted top level, so an allowed root can step back to it.
  const [rooted, setRooted] = useState(false);

  useEffect(() => {
    browse();
  }, []);

  function browse(dirPath?: string) {
    setError(null);
    api
      .get<DirectoryListing>(`/settings/browse-directory${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ""}`)
      .then((res) => {
        if (res.path === null) setRooted(true);
        setBrowsing(res);
      })
      .catch((err) => setError(errorMessage(err, "Couldn't browse that folder")));
  }

  if (!browsing) return error ? <FormMessage error={error} /> : <p className="text-sm text-muted">Loading…</p>;
  const currentPath = browsing.path;

  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <p className="truncate text-xs text-muted">{currentPath ?? "Folders Lifer can use"}</p>
      <div className="max-h-48 space-y-0.5 overflow-y-auto">
        {rooted && currentPath !== null && !browsing.parent && (
          <button
            onClick={() => browse()}
            className="block w-full rounded px-2 py-1 text-left text-sm text-muted hover:bg-surface-muted"
          >
            .. (all folders)
          </button>
        )}
        {browsing.parent && (
          <button
            onClick={() => browse(browsing.parent!)}
            className="block w-full rounded px-2 py-1 text-left text-sm text-muted hover:bg-surface-muted"
          >
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
        <Button size="sm" onClick={() => currentPath && onChoose(currentPath)} disabled={currentPath === null}>
          Use this folder
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <FormMessage error={error} />
    </div>
  );
}
