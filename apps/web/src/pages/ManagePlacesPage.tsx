import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { api, ApiError } from "../api/client";
import ManageListPage, { ManageList, RowRenameField } from "../components/ManageListPage";
import { docsUrl } from "../lib/docs";
import Button from "../components/Button";
import ConfirmDialog from "../components/ConfirmDialog";
import { AddSpotModal, SavedSpotsList } from "../components/SavedSpots";
import { PlaceSuggestionList, usePlaceSuggestions } from "../components/PlaceSuggestions";
import { useSavedSpots } from "../hooks/useSavedSpots";
import FormMessage from "../components/FormMessage";
import { usePlaceRegionText, type PlaceSuggestion } from "../components/PlaceNameInput";
import { backStateFor } from "../lib/backLabel";

// Library-wide place names: rename (or merge) or remove one on every photo in one request.
export default function ManagePlacesPage() {
  const { t } = useTranslation();
  const title = t("managePlaces.title");
  const location = useLocation();
  const regionText = usePlaceRegionText();
  const [places, setPlaces] = useState<PlaceSuggestion[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [confirmingMerge, setConfirmingMerge] = useState<{ from: PlaceSuggestion; to: string } | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<PlaceSuggestion | null>(null);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const saved = useSavedSpots();
  const suggested = usePlaceSuggestions(saved.spots);
  const [addingSpot, setAddingSpot] = useState(false);

  function fetchList() {
    api
      .get("/places")
      .then((res) => setPlaces(res.places))
      .catch(() => setLoadError(true));
  }

  // Retrying clears an earlier error; the first load has none to clear.
  function load() {
    setLoadError(false);
    fetchList();
  }

  useEffect(fetchList, []);

  // With place folders in the layout, the files move afterwards: wait for that to report it.
  async function report(done: { updated: number; movingFiles: boolean }, keys: { changed: string; moved: string }) {
    setNotice(t(keys.changed, { count: done.updated }));
    if (!done.movingFiles) return;
    try {
      let moves = await api.get("/places/file-moves/status");
      while (moves.running) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        moves = await api.get("/places/file-moves/status");
      }
      setNotice(t(keys.moved, { count: done.updated, moved: moves.moved, failed: moves.failed }));
    } catch {
      // The rename itself is saved; only the move report is missing.
    }
  }

  function startRename(name: string) {
    setEditing(name);
    setRenameDraft(name);
  }

  function requestRename(from: PlaceSuggestion) {
    const to = renameDraft.trim();
    if (!to || to === from.name) {
      setEditing(null);
      return;
    }
    if (places?.some((p) => p.name === to)) setConfirmingMerge({ from, to });
    else void rename(from.name, to);
  }

  async function rename(from: string, to: string) {
    setRenaming(true);
    setError(null);
    setNotice(null);
    try {
      const done = await api.post("/places/rename", { from, to });
      setEditing(null);
      setConfirmingMerge(null);
      load();
      void report(done, { changed: "managePlaces.renamed", moved: "managePlaces.renamedAndMoved" });
    } catch (err) {
      setConfirmingMerge(null);
      setError(err instanceof ApiError ? err.message : t("managePlaces.renameFailed"));
    } finally {
      setRenaming(false);
    }
  }

  async function confirmRemove() {
    if (!confirmingRemove) return;
    setRemoving(true);
    setNotice(null);
    try {
      const done = await api.post("/places/remove", { name: confirmingRemove.name });
      setConfirmingRemove(null);
      load();
      void report(done, { changed: "managePlaces.removed", moved: "managePlaces.removedAndMoved" });
    } catch {
      setError(t("managePlaces.removeFailed"));
    } finally {
      setRemoving(false);
    }
  }

  const query = search.trim().toLowerCase();
  const visible = (places ?? []).filter((p) => p.name.toLowerCase().includes(query));
  const galleryLink = (name: string) => `/gallery?place=${encodeURIComponent(name)}`;
  const linkState = backStateFor(location, t, title);

  return (
    <>
      <ManageListPage
        title={title}
        backLabel={t("managePlaces.backLabel")}
        description={t("managePlaces.intro")}
        help={[t("managePlaces.help.remove"), t("managePlaces.help.scope")]}
        docsHref={docsUrl("/settings#library-links")}
        search={{ value: search, onChange: setSearch, placeholder: t("managePlaces.searchPlaceholder") }}
        headerExtra={(error || notice) && <FormMessage error={error} success={notice} className="mt-3" />}
        loading={!places}
        error={loadError ? t("managePlaces.loadFailed") : null}
        onRetry={load}
        actions={
          <Button variant="secondary" onClick={() => setAddingSpot(true)}>
            {t("savedSpots.add")}
          </Button>
        }
        isEmpty={places?.length === 0 && saved.spots?.length === 0 && suggested.suggestions.length === 0}
        empty={{
          icon: (
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6 text-muted"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" />
              <circle cx="12" cy="9.5" r="2.5" />
            </svg>
          ),
          title: t("managePlaces.empty.title"),
          description: t("managePlaces.empty.description"),
        }}
        noMatch={visible.length === 0 ? t("managePlaces.noMatch", { search }) : null}
      >
        {suggested.suggestions.length > 0 && (
          <div className="mb-section">
            <PlaceSuggestionList {...suggested} onAdded={() => void saved.reload()} />
          </div>
        )}
        {saved.spots && saved.spots.length > 0 && (
          <div className="mb-section space-y-2">
            <h2 className="px-4 text-subheadline font-semibold text-ink">{t("savedSpots.title")}</h2>
            <SavedSpotsList
              spots={saved.spots}
              nearby={saved.nearby}
              reload={saved.reload}
              label={t("savedSpots.title")}
            />
          </div>
        )}
        <ManageList
          label={title}
          rows={visible.map((row) => ({
            key: row.name,
            primary: row.name,
            secondary: row.regionName ? regionText(row) : undefined,
            trailing: t("managePlaces.photoCount", { count: row.count }),
            to: galleryLink(row.name),
            linkState,
            menu: [
              { label: t("common.rename"), onSelect: () => startRename(row.name) },
              { label: t("managePlaces.remove"), danger: true, onSelect: () => setConfirmingRemove(row) },
            ],
            editor:
              editing === row.name ? (
                <RowRenameField
                  label={t("managePlaces.renameLabel", { name: row.name })}
                  value={renameDraft}
                  onChange={setRenameDraft}
                  onSave={() => requestRename(row)}
                  onCancel={() => setEditing(null)}
                  saving={renaming}
                />
              ) : undefined,
          }))}
        />
      </ManageListPage>
      {addingSpot && <AddSpotModal onClose={() => setAddingSpot(false)} onAdded={() => void saved.reload()} />}

      <ConfirmDialog
        open={!!confirmingMerge}
        title={t("managePlaces.mergeConfirm.title", {
          from: confirmingMerge?.from.name ?? "",
          to: confirmingMerge?.to ?? "",
        })}
        message={t("managePlaces.mergeConfirm.message", {
          count: confirmingMerge?.from.count ?? 0,
          to: confirmingMerge?.to ?? "",
        })}
        confirmLabel={t("managePlaces.mergeConfirm.confirm")}
        busy={renaming}
        onConfirm={() => confirmingMerge && void rename(confirmingMerge.from.name, confirmingMerge.to)}
        onCancel={() => setConfirmingMerge(null)}
      />
      <ConfirmDialog
        open={!!confirmingRemove}
        title={t("managePlaces.removeConfirm.title", {
          name: confirmingRemove?.name ?? "",
          count: confirmingRemove?.count ?? 0,
        })}
        message={t("managePlaces.removeConfirm.message")}
        confirmLabel={t("managePlaces.removeConfirm.confirm")}
        danger
        busy={removing}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setConfirmingRemove(null)}
      />
    </>
  );
}
