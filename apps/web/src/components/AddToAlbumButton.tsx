import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useToast } from "../hooks/useToast";

interface AlbumOption {
  id: string;
  name: string;
}

// "Add to album" dropdown for multi-select toolbars.
export default function AddToAlbumButton({ captureIds, onAdded }: { captureIds: string[]; onAdded?: () => void }) {
  const { openKey: open, setOpenKey: setOpen, ref } = useDropdownMenu<true>();
  const [albums, setAlbums] = useState<AlbumOption[] | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!open || albums) return;
    setLoadFailed(false);
    api
      .get<{ albums: AlbumOption[] }>("/albums")
      .then((res) => setAlbums(res.albums))
      .catch(() => setLoadFailed(true));
  }, [open, albums]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      setOpen(null);
      onAdded?.();
    } catch {
      toast.error("Couldn't add to the album. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const addTo = (albumId: string) =>
    run(async () => {
      await api.post(`/albums/${albumId}/captures`, { captureIds });
    });

  function createAndAdd(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    void run(async () => {
      const created = await api.post<{ id: string }>("/albums", { name: newName.trim() });
      await api.post(`/albums/${created.id}/captures`, { captureIds });
      setNewName("");
    });
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
          {loadFailed ? (
            <p className="px-3 py-1.5 text-xs text-muted">Couldn't load albums</p>
          ) : !albums ? (
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
