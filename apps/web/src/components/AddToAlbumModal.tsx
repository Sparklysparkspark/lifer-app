import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../api/client";
import Modal from "./Modal";
import Button from "./Button";
import FormMessage from "./FormMessage";
import { NameField } from "./TextField";
import EmptyState from "./EmptyState";
import SearchInput from "./SearchInput";
import { Spinner } from "./LoadingScreen";
import { useToast } from "../hooks/useToast";
import { normalizeForSearch } from "../lib/searchNormalize";

interface AlbumOption {
  id: string;
  name: string;
  createdAt?: string;
}

// Longer lists get a search box.
const SEARCH_AT = 8;
const RECENT_KEY = "lifer:recentAlbums";
const RECENT_MAX = 20;

function readRecent(): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(albumId: string) {
  try {
    const ids = [albumId, ...readRecent().filter((id) => id !== albumId)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids));
  } catch {
    // Only an ordering convenience; a private window simply forgets it.
  }
}

/** The albums last added to first (`recent`, newest first), then the newest albums. */
export function orderAlbums<T extends AlbumOption>(albums: T[], recent: string[]): T[] {
  const rank = new Map(recent.map((id, i) => [id, i]));
  return [...albums].sort((a, b) => {
    const ra = rank.get(a.id) ?? Infinity;
    const rb = rank.get(b.id) ?? Infinity;
    if (ra !== rb) return ra - rb;
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });
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
  // Smart albums were left out, so "no albums yet" wouldn't be true.
  const [hasSmart, setHasSmart] = useState(false);
  const [query, setQuery] = useState("");
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
        if (cancelled) return;
        setAlbums(
          orderAlbums(
            res.albums.filter((a) => !a.rules),
            readRecent(),
          ),
        );
        setHasSmart(res.albums.some((a) => a.rules));
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
      rememberRecent(albumId);
    });

  function createAndAdd(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    void run(newName.trim(), async () => {
      const created = await api.post("/albums", { name: newName.trim() });
      await api.post(apiPath("/albums/{id}/captures", { id: created.id }), { captureIds });
      rememberRecent(created.id);
    });
  }

  const q = normalizeForSearch(query.trim());
  const shown = albums && q ? albums.filter((a) => normalizeForSearch(a.name).includes(q)) : albums;

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
      {albums && albums.length > SEARCH_AT && (
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t("albums.sections.searchAlbums")}
          aria-label={t("albums.sections.searchAlbums")}
          className="mb-2"
        />
      )}
      <div className="mt-1 max-h-72 overflow-y-auto border-y border-line">
        {!albums || !shown ? (
          <Spinner />
        ) : albums.length === 0 ? (
          <EmptyState compact title={t(hasSmart ? "albums.addTo.onlySmart" : "albums.addTo.empty")} />
        ) : shown.length === 0 ? (
          <EmptyState compact title={t("albums.sections.noMatch", { query: query.trim() })} />
        ) : (
          shown.map((a) => (
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
