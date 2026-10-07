import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { TripSummary, QuadSlot } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { Spinner } from "../components/LoadingScreen";
import PageHeader from "../components/PageHeader";
import CoverImage from "../components/CoverImage";
import DotMenu from "../components/DotMenu";
import RenameModal from "../components/RenameModal";
import TripCard from "../components/TripCard";
import EmptyState from "../components/EmptyState";
import { FolderBrowser } from "../components/FolderPicker";
import { pickFolderNative } from "../lib/pickFolderNative";
import InfoTip from "../components/InfoTip";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useEnterToConfirm } from "../hooks/useEnterToConfirm";
import { useToast } from "../hooks/useToast";
import Modal from "../components/Modal";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import { useTranslation } from "react-i18next";

interface Album {
  id: string;
  name: string;
  description: string | null;
  coverPhotoId: string | null;
  coverLayout: "single" | "quad";
  coverCropX: number | null;
  coverCropY: number | null;
  coverCropSize: number | null;
  quadSlots: Array<QuadSlot | null>;
  createdAt: string;
  captureCount: number;
}

const TRIPS_INFO_PARAGRAPH_KEYS = [
  "trips.info.pointAtFolder",
  "trips.info.copiedOnImport",
  "trips.info.addMore",
  "trips.info.relocate",
] as const;

// Albums (curated) and Trips (from a scanned folder) are the same idea with different origins,
// so they share one page with a tab switch.
export default function CollectionsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const tab = location.pathname.startsWith("/trips") ? "trips" : "albums";
  const { t } = useTranslation();

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader
        sticky
        title={t("collections.title")}
        actions={
          <div className="flex rounded-md border border-line text-sm">
            <button
              onClick={() => navigate("/albums", { replace: true })}
              className={`rounded-l-md px-3 py-1.5 ${tab === "albums" ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-muted"}`}
            >
              {t("collections.tabs.albums")}
            </button>
            <button
              onClick={() => navigate("/trips", { replace: true })}
              className={`rounded-r-md px-3 py-1.5 ${tab === "trips" ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-muted"}`}
            >
              {t("collections.tabs.trips")}
            </button>
          </div>
        }
      />

      {tab === "trips" ? <TripsPanel /> : <AlbumsPanel />}
    </div>
  );
}

function AlbumsPanel() {
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingAlbum, setRenamingAlbum] = useState<Album | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { openKey: openMenuId, setOpenKey: setOpenMenuId, ref: openMenuRef } = useDropdownMenu<string>();
  useEnterToConfirm(() => void deleteAlbum(), !!confirmingDeleteId && !deleting);
  const toast = useToast();
  const navigate = useNavigate();
  const { t } = useTranslation();

  function fetchAlbums() {
    api
      .get<{ albums: Album[] }>("/albums")
      .then((res) => setAlbums(res.albums))
      .catch(() => setLoadError(true));
  }

  // Later reloads clear an earlier error while they retry; the first load has none to clear.
  function load() {
    setLoadError(false);
    fetchAlbums();
  }

  useEffect(fetchAlbums, []);

  async function createAlbum(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post<{ id: string }>("/albums", { name: name.trim() || undefined });
      navigate("/gallery?select=1");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("albums.create.failed"));
    } finally {
      setSaving(false);
    }
  }

  async function renameAlbum(name: string) {
    if (!renamingAlbum) return;
    await api.patch(`/albums/${renamingAlbum.id}`, { name });
    setRenamingAlbum(null);
    load();
  }

  async function deleteAlbum() {
    if (!confirmingDeleteId) return;
    setDeleting(true);
    try {
      await api.delete(`/albums/${confirmingDeleteId}`);
      setConfirmingDeleteId(null);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("albums.delete.failed"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-end gap-2 border-b border-line bg-surface px-6 py-2">
        <button
          onClick={() => {
            setCreating((c) => !c);
            setError(null);
          }}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg"
        >
          {creating ? t("common.cancel") : t("albums.list.newAlbum")}
        </button>
      </div>

      <main className="space-y-6 p-6">
        {creating && (
          <form
            onSubmit={createAlbum}
            className="flex max-w-md items-end gap-2 rounded-lg border border-line bg-surface p-4"
          >
            <div className="flex-1">
              <label className="mb-1 block text-sm font-medium text-ink">{t("common.name")}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("albums.create.namePlaceholder")}
                autoFocus
                className="w-full rounded-md border border-line px-3 py-2 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {saving ? t("common.creating") : t("albums.create.submit")}
            </button>
            <FormMessage error={error} />
          </form>
        )}

        {loadError ? (
          <div className="flex flex-col items-center gap-3 py-24">
            <p className="text-muted">{t("albums.list.loadFailed")}</p>
            <button onClick={load} className="text-sm text-ink underline">
              {t("common.retry")}
            </button>
          </div>
        ) : !albums ? (
          <Spinner />
        ) : albums.length === 0 ? (
          <EmptyState
            icon={
              <svg
                viewBox="0 0 24 24"
                className="h-6 w-6 text-muted"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 15.5V5.5A2 2 0 0 1 5 3.5h10" />
                <rect x="6" y="6" width="14" height="14" rx="2" />
              </svg>
            }
            title={t("albums.empty.title")}
            description={t("albums.empty.description")}
            action={{ label: t("albums.list.newAlbum"), onClick: () => setCreating(true) }}
          />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {albums.map((album) => (
              <Link
                key={album.id}
                to={`/albums/${album.id}`}
                className="group block overflow-hidden rounded-lg border border-line bg-surface transition hover:shadow-md"
              >
                <div className="relative aspect-square overflow-hidden bg-surface-muted">
                  <CoverImage
                    layout={album.coverLayout}
                    coverPhotoUrl={album.coverPhotoId ? `/api/photos/${album.coverPhotoId}/thumb` : null}
                    cropX={album.coverCropX}
                    cropY={album.coverCropY}
                    cropSize={album.coverCropSize}
                    quadSlots={album.quadSlots}
                    alt={album.name}
                  />
                  <DotMenu
                    open={openMenuId === album.id}
                    onToggle={() => setOpenMenuId(openMenuId === album.id ? null : album.id)}
                    menuRef={openMenuRef}
                  >
                    <div className="absolute right-0 top-full z-10 mt-1 w-36 rounded-md border border-line bg-surface py-1 shadow-lg">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setOpenMenuId(null);
                          setRenamingAlbum(album);
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                      >
                        {t("common.rename")}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setOpenMenuId(null);
                          setConfirmingDeleteId(album.id);
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-surface-muted dark:text-red-400"
                      >
                        {t("common.delete")}
                      </button>
                    </div>
                  </DotMenu>
                </div>
                <div className="p-3">
                  <p className="truncate font-medium leading-tight text-ink">{album.name}</p>
                  {/* Same count pill as TripCard. */}
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <span className="inline-block rounded-full bg-surface-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                      {t("albums.list.photoCount", { count: album.captureCount })}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>

      {renamingAlbum && (
        <RenameModal
          title={t("albums.rename.title")}
          initialName={renamingAlbum.name}
          onCancel={() => setRenamingAlbum(null)}
          onSave={renameAlbum}
        />
      )}

      <Modal
        open={!!confirmingDeleteId}
        onClose={() => setConfirmingDeleteId(null)}
        size="sm"
        title={t("albums.delete.title")}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingDeleteId(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" size="sm" onClick={deleteAlbum} loading={deleting}>
              {deleting ? t("common.deleting") : t("common.delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          {t("albums.delete.body")}
        </p>
      </Modal>
    </>
  );
}

function TripsPanel() {
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [building, setBuilding] = useState(false);
  const [name, setName] = useState("");
  const [chosenFolder, setChosenFolder] = useState<string | null>(null);
  const [browsingFolder, setBrowsingFolder] = useState(false);
  // Where an imported trip's wildlife is filed: null means the suggested "<trip folder>/Wildlife".
  const [destinationFolder, setDestinationFolder] = useState<string | null>(null);
  const [browsingDestination, setBrowsingDestination] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingTrip, setRenamingTrip] = useState<TripSummary | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { openKey: openMenuId, setOpenKey: setOpenMenuId, ref: openMenuRef } = useDropdownMenu<string>();
  useEnterToConfirm(() => void deleteTrip(), !!confirmingDeleteId && !deleting);
  const toast = useToast();
  const navigate = useNavigate();
  const { t } = useTranslation();

  function fetchTrips() {
    api
      .get<{ trips: TripSummary[] }>("/trips")
      .then((res) => setTrips(res.trips))
      .catch(() => setLoadError(true));
  }

  // Later reloads clear an earlier error while they retry; the first load has none to clear.
  function load() {
    setLoadError(false);
    fetchTrips();
  }

  useEffect(fetchTrips, []);

  // A trip still scanning its folder refreshes every 2s (paused while the tab is hidden), and
  // nothing lands after the panel unmounts.
  const anyProcessing = !!trips?.some((t) => t.processing);
  useEffect(() => {
    if (!anyProcessing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    function tick() {
      if (document.hidden) {
        timer = setTimeout(tick, 2000);
        return;
      }
      api
        .get<{ trips: TripSummary[] }>("/trips")
        .then((res) => {
          if (!cancelled) setTrips(res.trips);
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(tick, 2000);
        });
    }
    timer = setTimeout(tick, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [anyProcessing, trips]);

  async function chooseFolder() {
    const native = await pickFolderNative();
    if (native !== undefined) {
      if (native) setChosenFolder(native);
      return;
    }
    setBrowsingFolder(true);
  }

  async function chooseDestination() {
    const native = await pickFolderNative();
    if (native !== undefined) {
      if (native) setDestinationFolder(native);
      return;
    }
    setBrowsingDestination(true);
  }

  async function createTrip(e: React.FormEvent) {
    e.preventDefault();
    if (!chosenFolder) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post<{ id: string }>("/trips", {
        name: name.trim() || undefined,
        sourceFolder: chosenFolder,
        destinationFolder: destinationFolder ?? undefined,
      });
      navigate(`/trips/${res.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("trips.create.failed"));
    } finally {
      setSaving(false);
    }
  }

  async function buildTrip(e: React.FormEvent) {
    e.preventDefault();
    if (!chosenFolder) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post<{ id: string }>("/trips/build", {
        name: name.trim() || undefined,
        parentDir: chosenFolder,
      });
      navigate(`/trips/${res.id}?mode=build`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("trips.create.failed"));
    } finally {
      setSaving(false);
    }
  }

  async function renameTrip(name: string) {
    if (!renamingTrip) return;
    await api.patch(`/trips/${renamingTrip.id}`, { name });
    setRenamingTrip(null);
    load();
  }

  async function deleteTrip() {
    if (!confirmingDeleteId) return;
    setDeleting(true);
    try {
      await api.delete(`/trips/${confirmingDeleteId}`);
      setConfirmingDeleteId(null);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("trips.delete.failed"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-end gap-2 border-b border-line bg-surface px-6 py-2">
        <InfoTip paragraphs={TRIPS_INFO_PARAGRAPH_KEYS.map((key) => t(key))} align="right" />
        <button
          onClick={() => {
            setBuilding(false);
            setCreating((c) => !c);
            setChosenFolder(null);
            setDestinationFolder(null);
            setError(null);
          }}
          className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted"
        >
          {creating && !building ? t("common.cancel") : t("trips.list.importTrip")}
        </button>
        <button
          onClick={() => {
            setCreating(false);
            setBuilding((b) => !b);
            setChosenFolder(null);
            setError(null);
          }}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg"
        >
          {building ? t("common.cancel") : t("trips.list.buildTrip")}
        </button>
      </div>

      <main className="space-y-6 p-6">
        {(creating || building) && (
          <form
            onSubmit={building ? buildTrip : createTrip}
            className="max-w-md space-y-3 rounded-lg border border-line bg-surface p-4"
          >
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">{t("common.name")}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("trips.create.namePlaceholder")}
                className="w-full rounded-md border border-line px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">
                {building ? t("trips.create.buildParentLabel") : t("trips.create.folderLabel")}
              </label>
              {chosenFolder && !browsingFolder ? (
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded-md border border-line px-3 py-2 text-xs">
                    {chosenFolder}
                  </code>
                  <button
                    type="button"
                    onClick={chooseFolder}
                    className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted"
                  >
                    {t("trips.create.change")}
                  </button>
                </div>
              ) : browsingFolder ? (
                <FolderBrowser
                  onChoose={(path) => {
                    setChosenFolder(path);
                    setBrowsingFolder(false);
                  }}
                  onCancel={() => setBrowsingFolder(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={chooseFolder}
                  className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted"
                >
                  {t("trips.create.chooseFolder")}
                </button>
              )}
              {building && chosenFolder && (
                <p className="mt-1 text-xs text-muted">
                  {t("trips.create.buildHint", { name: name.trim() || t("trips.create.untitled") })}
                </p>
              )}
              {!building && (
                <p className="mt-1 text-xs text-muted">
                  {t("trips.create.folderHint")}
                </p>
              )}
            </div>
            {!building && chosenFolder && (
              <div>
                <label className="mb-1 block text-sm font-medium text-ink">{t("trips.create.destinationLabel")}</label>
                {browsingDestination ? (
                  <FolderBrowser
                    onChoose={(path) => {
                      setDestinationFolder(path);
                      setBrowsingDestination(false);
                    }}
                    onCancel={() => setBrowsingDestination(false)}
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <code className="flex-1 truncate rounded-md border border-line px-3 py-2 text-xs">
                      {destinationFolder ?? `${chosenFolder}/Wildlife`}
                    </code>
                    <button
                      type="button"
                      onClick={chooseDestination}
                      className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted"
                    >
                      {t("trips.create.change")}
                    </button>
                  </div>
                )}
                <p className="mt-1 text-xs text-muted">
                  {t("trips.create.destinationHint")}
                </p>
              </div>
            )}
            <FormMessage error={error} />
            <button
              type="submit"
              disabled={saving || !chosenFolder}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {saving ? t("common.creating") : building ? t("trips.create.buildSubmit") : t("trips.create.submit")}
            </button>
          </form>
        )}

        {loadError ? (
          <div className="flex flex-col items-center gap-3 py-24">
            <p className="text-muted">{t("trips.list.loadFailed")}</p>
            <button onClick={load} className="text-sm text-ink underline">
              {t("common.retry")}
            </button>
          </div>
        ) : !trips ? (
          <Spinner />
        ) : trips.length === 0 ? (
          <EmptyState
            icon={
              <svg
                viewBox="0 0 24 24"
                className="h-6 w-6 text-muted"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 21s-7-6.5-7-11.5A7 7 0 0 1 19 9.5C19 14.5 12 21 12 21Z" />
                <circle cx="12" cy="9.5" r="2.25" />
              </svg>
            }
            title={t("trips.empty.title")}
            description={t("trips.empty.description")}
            action={{
              label: t("trips.list.buildTrip"),
              onClick: () => {
                setCreating(false);
                setBuilding(true);
                setChosenFolder(null);
                setError(null);
              },
            }}
          />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {trips.map((trip) => (
              <TripCard
                key={trip.id}
                trip={trip}
                menuOpen={openMenuId === trip.id}
                onToggleMenu={() => setOpenMenuId(openMenuId === trip.id ? null : trip.id)}
                menuRef={openMenuRef}
                onRename={() => setRenamingTrip(trip)}
                onDelete={() => setConfirmingDeleteId(trip.id)}
              />
            ))}
          </div>
        )}
      </main>

      {renamingTrip && (
        <RenameModal
          title={t("trips.rename.title")}
          initialName={renamingTrip.name}
          onCancel={() => setRenamingTrip(null)}
          onSave={renameTrip}
        />
      )}

      <Modal
        open={!!confirmingDeleteId}
        onClose={() => setConfirmingDeleteId(null)}
        size="sm"
        title={t("trips.delete.title")}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingDeleteId(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" size="sm" onClick={deleteTrip} loading={deleting}>
              {deleting ? t("common.deleting") : t("common.delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          {t("trips.delete.body")}
        </p>
      </Modal>
    </>
  );
}
