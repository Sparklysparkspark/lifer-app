import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../api/client";
import Modal from "./Modal";
import Button from "./Button";
import FormMessage from "./FormMessage";
import { NameField } from "./TextField";
import EmptyState from "./EmptyState";
import { useToast } from "../hooks/useToast";

interface AlbumOption {
  id: string;
  name: string;
}

// Picks an album or creates one, for a photo menu's "Add to album" and the select toolbars.
export default function AddToAlbumModal({
  captureIds,
  onClose,
  onAdded,
}: {
  captureIds: string[];
  onClose: () => void;
  onAdded?: () => void;
}) {
  const { t } = useTranslation();
  const [albums, setAlbums] = useState<AlbumOption[] | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    api
      .get("/albums")
      .then((res) => {
        // A smart album's rules choose its photos, so it can't take hand-picked ones.
        if (!cancelled) setAlbums(res.albums.filter((a) => !a.rules));
      })
      .catch(() => {
        if (cancelled) return;
        setAlbums([]);
        setError(t("albums.addTo.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function run(album: string, action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onAdded?.();
      onClose();
      toast.success(t("albums.addTo.added", { count: captureIds.length, album }));
    } catch {
      setError(t("albums.addTo.failed"));
    } finally {
      setBusy(false);
    }
  }

  const addTo = (albumId: string, name: string) =>
    run(name, async () => {
      await api.post(apiPath("/albums/{id}/captures", { id: albumId }), { captureIds });
    });

  function createAndAdd(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    void run(newName.trim(), async () => {
      const created = await api.post("/albums", { name: newName.trim() });
      await api.post(apiPath("/albums/{id}/captures", { id: created.id }), { captureIds });
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("albums.addTo.title", { count: captureIds.length })}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      }
    >
      <div className="mt-1 max-h-56 overflow-y-auto border-y border-line">
        {!albums ? (
          <p className="py-2 text-callout text-muted">{t("common.loading")}</p>
        ) : albums.length === 0 ? (
          <EmptyState compact title={t("albums.addTo.empty")} />
        ) : (
          albums.map((a) => (
            // raw-control: a row of the album list, not a free-standing button.
            <button
              key={a.id}
              type="button"
              disabled={busy}
              onClick={() => addTo(a.id, a.name)}
              className="block w-full border-b border-line px-3 py-2 text-left text-callout text-ink last:border-0 hover:bg-surface-muted disabled:opacity-40"
            >
              {a.name}
            </button>
          ))
        )}
      </div>
      <form onSubmit={createAndAdd} className="mt-3 flex gap-2">
        <div className="min-w-0 flex-1">
          <NameField
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("albums.addTo.newPlaceholder")}
            disabled={busy}
          />
        </div>
        <Button type="submit" className="shrink-0" disabled={busy || !newName.trim()}>
          {t("albums.create.submit")}
        </Button>
      </form>
      <FormMessage error={error} className="mt-3" />
    </Modal>
  );
}
