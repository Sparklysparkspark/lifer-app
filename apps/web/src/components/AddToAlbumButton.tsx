import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useDropdownMenu } from "../hooks/useDropdownMenu";

interface AlbumOption {
  id: string;
  name: string;
}

// Shared "add these captures to an album" control — used from every page's multi-select
// toolbar (Gallery, Trip, Species detail) so the album-picking UX stays identical everywhere
// rather than being rebuilt per page.
export default function AddToAlbumButton({ captureIds, onAdded }: { captureIds: string[]; onAdded?: () => void }) {
  const { openKey: open, setOpenKey: setOpen, ref } = useDropdownMenu<true>();
  const [albums, setAlbums] = useState<AlbumOption[] | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && !albums) {
      api.get<{ albums: AlbumOption[] }>("/albums").then((res) => setAlbums(res.albums));
    }
  }, [open, albums]);

  async function addTo(albumId: string) {
    setBusy(true);
    try {
      await api.post(`/albums/${albumId}/captures`, { captureIds });
      setOpen(null);
      onAdded?.();
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
      setNewName("");
      setOpen(null);
      onAdded?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" ref={open ? ref : undefined}>
      <button
        type="button"
        onClick={() => setOpen(open ? null : true)}
        disabled={captureIds.length === 0}
        className="shrink-0 rounded-md border border-line bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-surface-muted disabled:opacity-40"
      >
        Add to album
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 w-56 rounded-md border border-line bg-surface py-1 shadow-lg">
          {!albums ? (
            <p className="px-3 py-1.5 text-xs text-muted">Loading…</p>
          ) : albums.length === 0 ? (
            <p className="px-3 py-1.5 text-xs text-muted">No albums yet</p>
          ) : (
            <div className="max-h-48 overflow-y-auto">
              {albums.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  disabled={busy}
                  onClick={() => addTo(a.id)}
                  className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-40"
                >
                  {a.name}
                </button>
              ))}
            </div>
          )}
          <form onSubmit={createAndAdd} className="border-t border-line px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New album…"
              disabled={busy}
              className="w-full rounded border border-line px-2 py-1 text-xs"
            />
          </form>
        </div>
      )}
    </div>
  );
}
