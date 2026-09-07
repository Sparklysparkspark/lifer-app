import { useEffect, useState } from "react";
import { api } from "../api/client";

interface AlbumOption {
  id: string;
  name: string;
}

// Same album-list-or-create-new choice as AddToAlbumButton's dropdown, but as a centered
// modal instead of a menu-anchored flyout — for reaching this from somewhere that's already
// inside its OWN open dropdown (a photo's "⋯" menu), where nesting a second flyout dropdown
// would fight the first one's positioning/outside-click handling.
export default function AddToAlbumModal({
  captureIds,
  onClose,
  onAdded,
}: {
  captureIds: string[];
  onClose: () => void;
  onAdded?: () => void;
}) {
  const [albums, setAlbums] = useState<AlbumOption[] | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ albums: AlbumOption[] }>("/albums").then((res) => setAlbums(res.albums));
  }, []);

  async function addTo(albumId: string) {
    setBusy(true);
    try {
      await api.post(`/albums/${albumId}/captures`, { captureIds });
      onAdded?.();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function createAndAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const created = await api.post<{ id: string }>("/albums", { name: newName.trim() });
      await api.post(`/albums/${created.id}/captures`, { captureIds });
      onAdded?.();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-medium text-ink">
          Add {captureIds.length} photo{captureIds.length === 1 ? "" : "s"} to album
        </h3>
        <div className="mt-3 max-h-56 overflow-y-auto rounded-md border border-line">
          {!albums ? (
            <p className="px-3 py-2 text-xs text-muted">Loading…</p>
          ) : albums.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted">No albums yet. Create one below.</p>
          ) : (
            albums.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={busy}
                onClick={() => addTo(a.id)}
                className="block w-full border-b border-line px-3 py-2 text-left text-sm text-ink last:border-0 hover:bg-surface-muted disabled:opacity-40"
              >
                {a.name}
              </button>
            ))
          )}
        </div>
        <form onSubmit={createAndAdd} className="mt-3 flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New album…"
            disabled={busy}
            className="flex-1 rounded-md border border-line px-2 py-1.5 text-sm"
          />
          <button
            type="submit"
            disabled={busy || !newName.trim()}
            className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            Create
          </button>
        </form>
        <button onClick={onClose} className="mt-3 text-sm text-muted hover:underline">
          Cancel
        </button>
      </div>
    </div>
  );
}
