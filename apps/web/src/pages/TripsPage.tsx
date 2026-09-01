import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { TripSummary } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { Spinner } from "../components/LoadingScreen";
import BackToCollectionLink from "../components/BackToCollectionLink";
import TripCard from "../components/TripCard";
import { FolderBrowser, pickFolderNative } from "../components/FolderPicker";
import InfoTip from "../components/InfoTip";

const TRIPS_INFO_PARAGRAPHS = [
  "A trip points at a folder of photos already on your computer. Lifer references them right where they are and never copies or moves them.",
  'After you create a trip, review the new photos and assign a species to each one. Add more photos to the same folder anytime, then use "Add more photos" to bring in whatever\'s new.',
  'Suggested layout: an "Adjusted" subfolder with your edited JPEGs and a "RAW" subfolder with the originals. When you add a photo from Adjusted, Lifer automatically links up its matching RAW file by filename and timestamp. You can download it later from that photo\'s "⋯" menu.',
  'If the folder ever moves (a new computer, a reinstall, a renamed drive), use "Relocate…" on the trip to point at it again instead of re-importing from scratch.',
];

export default function TripsPage() {
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [building, setBuilding] = useState(false);
  const [name, setName] = useState("");
  const [chosenFolder, setChosenFolder] = useState<string | null>(null);
  const [browsingFolder, setBrowsingFolder] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  function load() {
    setLoadError(false);
    api
      .get<{ trips: TripSummary[] }>("/trips")
      .then((res) => setTrips(res.trips))
      .catch(() => setLoadError(true));
  }

  useEffect(load, []);

  // Re-polls the list while any trip is mid-scan/import (see TripCard's spinner state) so its
  // card's cover photo appears on its own once the job finishes, without a manual refresh.
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
    if (!name.trim() || !chosenFolder) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post<{ id: string }>("/trips", { name: name.trim(), sourceFolder: chosenFolder });
      navigate(`/trips/${res.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create this trip");
    } finally {
      setSaving(false);
    }
  }

  // "Build a Trip" — the opposite of "Import Trip": instead of pointing at a folder the user
  // already organized by hand, this creates a brand-new "Wildlife" folder under wherever they
  // pick and lands on that trip's own detail page in upload mode (see TripDetailPage.tsx's own
  // ?mode=build handling), ready to add photos directly rather than requiring the user to file
  // them into the right subfolders externally first.
  async function buildTrip(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !chosenFolder) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post<{ id: string }>("/trips/build", { name: name.trim(), parentDir: chosenFolder });
      navigate(`/trips/${res.id}?mode=build`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create this trip");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-canvas">
      <header className="page-header flex items-center justify-between border-b border-line bg-surface px-6 py-4">
        <div>
          <BackToCollectionLink className="text-sm text-muted hover:underline" />
          <h1 className="mt-1 text-lg font-semibold text-ink">Trips</h1>
        </div>
        <div className="flex items-center gap-2">
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
      </header>

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
                required
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
                  Lifer will create "{name.trim() || "(name)"}/Wildlife" inside this folder.
                </p>
              )}
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={saving || !name.trim() || !chosenFolder}
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
          <p className="text-muted">No trips yet — create one to start referencing wildlife photos from an external folder.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {trips.map((trip) => (
              <TripCard key={trip.id} trip={trip} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
