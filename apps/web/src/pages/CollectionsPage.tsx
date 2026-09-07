import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { TripSummary } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { Spinner } from "../components/LoadingScreen";
import PageHeader from "../components/PageHeader";
import ProgressiveImg from "../components/ProgressiveImg";
import PhotoPlaceholder from "../components/PhotoPlaceholder";
import DotMenu from "../components/DotMenu";
import RenameModal from "../components/RenameModal";
import TripCard from "../components/TripCard";
import { FolderBrowser, pickFolderNative } from "../components/FolderPicker";
import InfoTip from "../components/InfoTip";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useDesktopMode } from "../hooks/useDesktopMode";

interface Album {
  id: string;
  name: string;
  description: string | null;
  coverPhotoId: string | null;
  createdAt: string;
  captureCount: number;
}

const TRIPS_INFO_PARAGRAPHS = [
  "A trip points at a folder of photos already on your computer. Lifer references them right where they are and never copies or moves them.",
  'After you create a trip, review the new photos and assign a species to each one. Add more photos to the same folder anytime, then use "Add more photos" to bring in whatever\'s new.',
  'Suggested layout: an "Adjusted" subfolder with your edited JPEGs and a "RAW" subfolder with the originals. When you add a photo from Adjusted, Lifer automatically links up its matching RAW file by filename and timestamp. You can download it later from that photo\'s "⋯" menu.',
  'If the folder ever moves (a new computer, a reinstall, a renamed drive), use "Relocate…" on the trip to point at it again instead of re-importing from scratch.',
];

// Albums and Trips are the same underlying idea (a name plus a set of photos you browse as one
// unit) with different origins (manually curated vs. auto-populated from a scanned folder) — one
// page with a tab switch instead of two separate nav destinations, so browsing one naturally
// surfaces the other. Trips stays desktop-only (see useDesktopMode), so the tab switcher itself
// only shows up there; a server/self-hosted visitor just sees Albums, same as before.
export default function CollectionsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const isDesktopMode = useDesktopMode();
  const tab = isDesktopMode && location.pathname.startsWith("/trips") ? "trips" : "albums";

  return (
    <div className="min-h-screen bg-canvas">
      <PageHeader
        title="Albums & Trips"
        actions={
          isDesktopMode && (
            <div className="flex rounded-md border border-line text-sm">
              <button
                onClick={() => navigate("/albums", { replace: true })}
                className={`rounded-l-md px-3 py-1.5 ${tab === "albums" ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-muted"}`}
              >
                Albums
              </button>
              <button
                onClick={() => navigate("/trips", { replace: true })}
                className={`rounded-r-md px-3 py-1.5 ${tab === "trips" ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-muted"}`}
              >
                Trips
              </button>
            </div>
          )
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
  const navigate = useNavigate();

  function load() {
    setLoadError(false);
    api
      .get<{ albums: Album[] }>("/albums")
      .then((res) => setAlbums(res.albums))
      .catch(() => setLoadError(true));
  }

  useEffect(load, []);

  async function createAlbum(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await api.post<{ id: string }>("/albums", { name: name.trim() || undefined });
      navigate("/gallery?select=1");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create this album");
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
          {creating ? "Cancel" : "New album"}
        </button>
      </div>

      <main className="space-y-6 p-6">
        {creating && (
          <form onSubmit={createAlbum} className="flex max-w-md items-end gap-2 rounded-lg border border-line bg-surface p-4">
            <div className="flex-1">
              <label className="mb-1 block text-sm font-medium text-ink">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Best raptor shots"
                autoFocus
                className="w-full rounded-md border border-line px-3 py-2 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {saving ? "Creating…" : "Create"}
            </button>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </form>
        )}

        {loadError ? (
          <div className="flex flex-col items-center gap-3 py-24">
            <p className="text-muted">Couldn't load albums.</p>
            <button onClick={load} className="text-sm text-ink underline">
              Retry
            </button>
          </div>
        ) : !albums ? (
          <Spinner />
        ) : albums.length === 0 ? (
          <p className="text-muted">
            No albums yet. Group your favorite photos into a named collection you can browse or share.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {albums.map((album) => (
              <Link
                key={album.id}
                to={`/albums/${album.id}`}
                className="group block overflow-hidden rounded-lg border border-line bg-surface transition hover:shadow-md"
              >
                <div className="relative aspect-square overflow-hidden bg-surface-muted">
                  {album.coverPhotoId ? (
                    <ProgressiveImg
                      thumbSrc={`/api/photos/${album.coverPhotoId}/thumb`}
                      fullSrc={`/api/photos/${album.coverPhotoId}/display`}
                      alt={album.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <PhotoPlaceholder className="h-full w-full" />
                  )}
                  <DotMenu open={openMenuId === album.id} onToggle={() => setOpenMenuId(openMenuId === album.id ? null : album.id)} menuRef={openMenuRef}>
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
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setOpenMenuId(null);
                          setConfirmingDeleteId(album.id);
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-surface-muted"
                      >
                        Delete
                      </button>
                    </div>
                  </DotMenu>
                </div>
                <div className="p-3">
                  <p className="truncate font-medium leading-tight text-ink">{album.name}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {album.captureCount} photo{album.captureCount === 1 ? "" : "s"}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>

      {renamingAlbum && (
        <RenameModal
          title="Rename album"
          initialName={renamingAlbum.name}
          onCancel={() => setRenamingAlbum(null)}
          onSave={renameAlbum}
        />
      )}

      {confirmingDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmingDeleteId(null)}>
          <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-medium text-ink">Delete this album?</h3>
            <p className="mt-2 text-xs text-muted">
              This removes the album, but the photos in it aren't deleted. They stay right where they are.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmingDeleteId(null)} className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-muted">
                Cancel
              </button>
              <button
                onClick={deleteAlbum}
                disabled={deleting}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingTrip, setRenamingTrip] = useState<TripSummary | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { openKey: openMenuId, setOpenKey: setOpenMenuId, ref: openMenuRef } = useDropdownMenu<string>();
  const navigate = useNavigate();

  function load() {
    setLoadError(false);
    api
      .get<{ trips: TripSummary[] }>("/trips")
      .then((res) => setTrips(res.trips))
      .catch(() => setLoadError(true));
  }

  useEffect(load, []);

  useEffect(() => {
    if (!trips?.some((t) => t.processing)) return;
    const timer = setTimeout(load, 2000);
    return () => clearTimeout(timer);
  }, [trips]);

  async function chooseFolder() {
    const native = await pickFolderNative();
    if (native !== undefined) {
      if (native) setChosenFolder(native);
      return;
    }
    setBrowsingFolder(true);
  }

  async function createTrip(e: React.FormEvent) {
    e.preventDefault();
    if (!chosenFolder) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post<{ id: string }>("/trips", { name: name.trim() || undefined, sourceFolder: chosenFolder });
      navigate(`/trips/${res.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create this trip");
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
      const res = await api.post<{ id: string }>("/trips/build", { name: name.trim() || undefined, parentDir: chosenFolder });
      navigate(`/trips/${res.id}?mode=build`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create this trip");
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
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-end gap-2 border-b border-line bg-surface px-6 py-2">
        <InfoTip paragraphs={TRIPS_INFO_PARAGRAPHS} align="right" />
        <button
          onClick={() => {
            setBuilding(false);
            setCreating((c) => !c);
            setChosenFolder(null);
            setError(null);
          }}
          className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted"
        >
          {creating && !building ? "Cancel" : "Import Trip"}
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
          {building ? "Cancel" : "Build a Trip"}
        </button>
      </div>

      <main className="space-y-6 p-6">
        {(creating || building) && (
          <form
            onSubmit={building ? buildTrip : createTrip}
            className="max-w-md space-y-3 rounded-lg border border-line bg-surface p-4"
          >
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Costa Rica 2026"
                className="w-full rounded-md border border-line px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">
                {building ? "Where should the trip folder go?" : "Wildlife folder"}
              </label>
              {chosenFolder && !browsingFolder ? (
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded-md border border-line px-3 py-2 text-xs">{chosenFolder}</code>
                  <button
                    type="button"
                    onClick={chooseFolder}
                    className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted"
                  >
                    Change
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
                  Choose a folder…
                </button>
              )}
              {building && chosenFolder && (
                <p className="mt-1 text-xs text-muted">
                  Lifer will create "{name.trim() || "Untitled Trip"}/Wildlife" inside this folder.
                </p>
              )}
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={saving || !chosenFolder}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {saving ? "Creating…" : building ? "Create folder & start" : "Create trip"}
            </button>
          </form>
        )}

        {loadError ? (
          <div className="flex flex-col items-center gap-3 py-24">
            <p className="text-muted">Couldn't load trips.</p>
            <button onClick={load} className="text-sm text-ink underline">
              Retry
            </button>
          </div>
        ) : !trips ? (
          <Spinner />
        ) : trips.length === 0 ? (
          <p className="text-muted">No trips yet. Create one to start referencing wildlife photos from an external folder.</p>
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
          title="Rename trip"
          initialName={renamingTrip.name}
          onCancel={() => setRenamingTrip(null)}
          onSave={renameTrip}
        />
      )}

      {confirmingDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmingDeleteId(null)}>
          <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-medium text-ink">Delete this trip?</h3>
            <p className="mt-2 text-xs text-muted">
              This removes the trip, but the photos in it aren't deleted. They just won't be grouped under it anymore.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmingDeleteId(null)} className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-muted">
                Cancel
              </button>
              <button
                onClick={deleteTrip}
                disabled={deleting}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
