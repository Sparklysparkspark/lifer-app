import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import Modal from "./Modal";
import Button from "./Button";
import FormMessage from "./FormMessage";
import { pluralize } from "../lib/pluralize";

interface AlbumOption {
  id: string;
  name: string;
}

// AddToAlbumButton's picker as a centered modal, for use from inside another open menu.
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ albums: AlbumOption[] }>("/albums")
      .then((res) => {
        if (!cancelled) setAlbums(res.albums);
      })
      .catch(() => {
        if (cancelled) return;
        setAlbums([]);
        setError("Couldn't load your albums.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onAdded?.();
      onClose();
    } catch {
      setError("Couldn't add to the album. Try again.");
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
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Add ${pluralize(captureIds.length, "photo")} to album`}
      footer={
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div className="mt-1 max-h-56 overflow-y-auto rounded-md border border-line">
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
          className="flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
        />
        <Button type="submit" size="sm" className="shrink-0" disabled={busy || !newName.trim()}>
          Create
        </Button>
      </form>
      <FormMessage error={error} className="mt-3" />
    </Modal>
  );
}
