import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { CollectionItem } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { Spinner } from "../components/LoadingScreen";
import BackToCollectionLink from "../components/BackToCollectionLink";
import SpeciesPicker, { type SpeciesResult } from "../components/SpeciesPicker";
import SpeciesCard from "../components/SpeciesCard";
import MasonryGrid from "../components/MasonryGrid";
import ProgressiveImg from "../components/ProgressiveImg";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import CardCropEditor from "../components/CardCropEditor";
import { FolderBrowser, pickFolderNative } from "../components/FolderPicker";
import InfoTip from "../components/InfoTip";
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
import { useStorageVolumes } from "../hooks/useStorageVolumes";

const RELOCATE_INFO_PARAGRAPHS = [
  "Use this if this trip's folder moved: a new computer, a reinstall, a renamed drive.",
  "It doesn't move or copy any files. It just updates the path Lifer has stored, then automatically rescans the new location and relinks your existing photos by their content. You won't need to reassign species to anything that's already here.",
];

interface TripDetail {
  id: string;
  name: string;
  sourceFolder: string;
  coverCaptureId: string | null;
  coverCropX: number | null;
  coverCropY: number | null;
  coverCropSize: number | null;
}

interface TripPhoto {
  photoId: string;
  captureId: string;
  speciesId: string;
  scientificName: string;
  commonName: string | null;
  takenAt: string | null;
  hasRaw: boolean;
}

interface ScanStatus {
  running: boolean;
  error: string | null;
  finishedAt: number | null;
  relinked: number;
  markedStale: number;
  collisions: number;
  recovered: number;
  rawsLinked: number;
  newFiles: Array<{ relativePath: string }>;
}

interface ImportStatus {
  running: boolean;
  processed: number;
  total: number;
  error: string | null;
  finishedAt: number | null;
  results: Array<{ relativePath: string; captureId?: string; error?: string }>;
}

type ReviewRowStatus = "pending" | "ready" | "importing" | "done" | "error";

interface ReviewRow {
  relativePath: string;
  speciesId: string | null;
  speciesLabel: string | null;
  status: ReviewRowStatus;
  error?: string;
}

type View = "gallery" | "species";

// Default view is a plain photo grid (every capture from this trip) — same
// MasonryGrid/ProgressiveImg/Lightbox rendering GalleryPage.tsx uses for the all-species
// gallery, since a trip is "what did I photograph here," not a per-species checklist first. A
// "Species view" toggle switches to the same SpeciesCard grid the collection page uses, scoped
// to just this trip's species. The species-assignment review flow (mirroring
// BulkImportPage.tsx's own row+SpeciesPicker UI) is hidden until "Add more photos" is clicked
// and a scan actually finds something — never open by default.
export default function TripDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [trip, setTrip] = useState<TripDetail | null>(null);
  const [photos, setPhotos] = useState<TripPhoto[] | null>(null);
  const [speciesItems, setSpeciesItems] = useState<CollectionItem[] | null>(null);
  const [view, setView] = useState<View>("gallery");
  const [loadError, setLoadError] = useState(false);
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  const { multiDriveInUse } = useStorageVolumes();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [search, setSearch] = useState("");
  const [settingCover, setSettingCover] = useState<string | null>(null);
  const [openMenuCaptureId, setOpenMenuCaptureId] = useState<string | null>(null);
  const [croppingCoverPhotoUrl, setCroppingCoverPhotoUrl] = useState<string | null>(null);
  // Filled the instant an import starts and drained as each file's result comes back — lets
  // the grid show a loading tile per in-flight photo instead of the review table staying open
  // (see importReady below: the review section closes immediately, matching "add photos, land
  // back on the gallery, watch them fill in" rather than watching a status table).
  const [pendingImports, setPendingImports] = useState<string[]>([]);

  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const [relocating, setRelocating] = useState(false);
  const [relocateError, setRelocateError] = useState<string | null>(null);

  // Same dismiss-on-outside-click as SpeciesDetailPage's own "⋯" photo menu — scoped to
  // clicks outside the menu itself so its own buttons still work normally.
  const openMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openMenuCaptureId) return;
    const closeIfOutside = (e: MouseEvent) => {
      if (openMenuRef.current && !openMenuRef.current.contains(e.target as Node)) setOpenMenuCaptureId(null);
    };
    document.addEventListener("click", closeIfOutside);
    return () => document.removeEventListener("click", closeIfOutside);
  }, [openMenuCaptureId]);

  function load() {
    if (!id) return;
    setLoadError(false);
    Promise.all([
      api.get<TripDetail>(`/trips/${id}`),
      api.get<{ items: TripPhoto[] }>(`/trips/${id}/photos`),
      api.get<{ items: CollectionItem[] }>(`/trips/${id}/species`),
    ])
      .then(([tripRes, photosRes, speciesRes]) => {
        setTrip(tripRes);
        setPhotos(photosRes.items);
        setSpeciesItems(speciesRes.items);
      })
      .catch(() => setLoadError(true));
  }

  useEffect(load, [id]);

  // In-view text filter — same pattern as CollectionPage/ArchivedSpeciesPage's own search: no
  // server round-trip, just filters whatever's already on screen.
  const visiblePhotos = useMemo(() => {
    if (!photos) return [];
    const query = search.trim().toLowerCase();
    if (!query) return photos;
    return photos.filter((p) => (p.commonName ?? "").toLowerCase().includes(query) || p.scientificName.toLowerCase().includes(query));
  }, [photos, search]);

  const visibleSpecies = useMemo(() => {
    if (!speciesItems) return [];
    const query = search.trim().toLowerCase();
    if (!query) return speciesItems;
    return speciesItems.filter(
      (s) => (s.commonName ?? "").toLowerCase().includes(query) || s.scientificName.toLowerCase().includes(query),
    );
  }, [speciesItems, search]);

  const slides = useMemo<LightboxSlide[]>(
    () =>
      visiblePhotos.map((p) => ({
        url: `/api/photos/${p.photoId}/display`,
        caption: `${p.commonName ?? p.scientificName}${p.takenAt ? " · " + new Date(p.takenAt).toLocaleDateString() : ""}`,
      })),
    [visiblePhotos],
  );

  async function startScan() {
    if (!id) return;
    setScanError(null);
    setScanning(true);
    try {
      await api.post(`/trips/${id}/scan`);
    } catch (err) {
      setScanError(err instanceof ApiError ? err.message : "Couldn't start the scan");
      setScanning(false);
    }
  }

  // Polls while a scan is running — never fetched/shown until "Add more photos" is clicked.
  useEffect(() => {
    if (!id || !scanning) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const res = await api.get<ScanStatus>(`/trips/${id}/scan/status`);
        if (cancelled) return;
        setScanStatus(res);
        if (!res.running) {
          setScanning(false);
          setReviewRows(
            res.newFiles.map((f) => ({ relativePath: f.relativePath, speciesId: null, speciesLabel: null, status: "ready" })),
          );
          if (res.recovered > 0) load();
          return;
        }
      } catch {
        // ignore — status just won't update this tick
      }
      if (!cancelled) timer = setTimeout(poll, 1500);
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, scanning]);

  function assignSpecies(paths: string[], result: SpeciesResult) {
    setReviewRows((prev) =>
      prev.map((r) => (paths.includes(r.relativePath) ? { ...r, speciesId: result.id, speciesLabel: result.common_name ?? result.scientific_name } : r)),
    );
  }

  function assignAndAdvance(relativePath: string, result: SpeciesResult) {
    assignSpecies([relativePath], result);
    const idx = reviewRows.findIndex((r) => r.relativePath === relativePath);
    const next = reviewRows.slice(idx + 1).find((r) => !r.speciesId);
    setFocusedRow(next ? next.relativePath : null);
  }

  function toggleSelected(relativePath: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(relativePath)) next.delete(relativePath);
      else next.add(relativePath);
      return next;
    });
  }

  // Fire-and-poll, same as the scan job just above — a single request the client awaited
  // directly would hang the page on the whole batch (each file pays a real exiftool round-trip
  // + a sharp resize) with no way to show progress in the meantime. Closes the review section
  // immediately rather than watching it update in place — the main grid's own loading tiles
  // (driven by pendingImports below) are the feedback now.
  async function importReady() {
    if (!id) return;
    const toImport = reviewRows.filter((r) => r.speciesId && (r.status === "ready" || r.status === "error"));
    if (toImport.length === 0) return;
    setImportError(null);
    setImporting(true);
    setPendingImports(toImport.map((r) => r.relativePath));
    setReviewRows([]);
    try {
      await api.post(`/trips/${id}/import`, { files: toImport.map((r) => ({ relativePath: r.relativePath, speciesId: r.speciesId })) });
    } catch (err) {
      setImportError(err instanceof ApiError ? err.message : "Couldn't start the import");
      setImporting(false);
      setPendingImports([]);
    }
  }

  useEffect(() => {
    if (!id || !importing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let lastResultCount = 0;
    async function poll() {
      try {
        const res = await api.get<ImportStatus>(`/trips/${id}/import/status`);
        if (cancelled) return;
        setImportStatus(res);
        if (res.results.length > lastResultCount) {
          lastResultCount = res.results.length;
          const done = new Set(res.results.map((r) => r.relativePath));
          setPendingImports((prev) => prev.filter((p) => !done.has(p)));
          // A newly-completed photo needs its real thumb/display files picked up — cheap
          // enough to just refetch the whole list as results trickle in rather than trying to
          // splice one photo in by hand from a result that only carries a captureId.
          load();
        }
        if (!res.running) {
          setImporting(false);
          setPendingImports([]);
          load();
          return;
        }
      } catch {
        // ignore — status just won't update this tick
      }
      if (!cancelled) timer = setTimeout(poll, 1000);
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, importing]);

  async function setCover(captureId: string | null) {
    if (!id) return;
    setOpenMenuCaptureId(null);
    setSettingCover(captureId);
    try {
      await api.put(`/trips/${id}/cover`, { captureId });
      load();
    } catch {
      // A failed cover pick isn't worth a whole error banner — the star just won't have moved.
    } finally {
      setSettingCover(null);
    }
  }

  // Newly-set covers go straight into the crop editor instead of leaving the user to reopen
  // the menu a second time and click "Adjust position" — the position is exactly what
  // someone picking a featured photo wants to set right away.
  async function setCoverAndEdit(captureId: string, photoUrl: string) {
    if (!id) return;
    setOpenMenuCaptureId(null);
    setSettingCover(captureId);
    try {
      await api.put(`/trips/${id}/cover`, { captureId });
      await load();
      setCroppingCoverPhotoUrl(photoUrl);
    } catch {
      // Same "no error banner" call as setCover above.
    } finally {
      setSettingCover(null);
    }
  }

  async function relocateFolder() {
    if (!id) return;
    setRelocateError(null);
    const native = await pickFolderNative();
    if (native === undefined) {
      setRelocating(true);
      return;
    }
    if (!native) return;
    await applyRelocate(native);
  }

  async function applyRelocate(sourceFolder: string) {
    if (!id) return;
    setRelocating(false);
    setRelocateError(null);
    try {
      await api.patch(`/trips/${id}`, { sourceFolder });
      load();
      // The whole point of relocating is picking back up where things left off — a rescan
      // against the new location relinks every existing photo by content hash automatically
      // (see scan.ts), same mechanism as a file moving within a trip's own folder.
      startScan();
    } catch (err) {
      setRelocateError(err instanceof ApiError ? err.message : "Couldn't relocate this trip's folder");
    }
  }

  const readyCount = reviewRows.filter((r) => r.speciesId && r.status === "ready").length;

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-3 py-24">
        <p className="text-muted">Couldn't load this trip.</p>
        <button onClick={load} className="text-sm text-ink underline">
          Retry
        </button>
      </div>
    );
  }
  if (!trip || !photos || !speciesItems) return <Spinner />;

  type GridItem = { kind: "placeholder"; key: string } | { kind: "photo"; photo: TripPhoto; photoIndex: number };
  const gridItems: GridItem[] = [
    ...pendingImports.map((relativePath): GridItem => ({ kind: "placeholder", key: relativePath })),
    ...visiblePhotos.map((photo, photoIndex): GridItem => ({ kind: "photo", photo, photoIndex })),
  ];

  return (
    <div className="min-h-screen bg-canvas">
      <header className="page-header flex items-center justify-between border-b border-line bg-surface px-6 py-4">
        <div>
          <BackToCollectionLink fallbackTo="/trips" label="Trips" className="text-sm text-muted hover:underline" />
          <h1 className="mt-1 text-lg font-semibold text-ink">{trip.name}</h1>
          <p className="flex items-center gap-2 truncate text-xs text-muted">
            <span className="truncate">{trip.sourceFolder}</span>
            <button onClick={relocateFolder} className="shrink-0 underline hover:text-ink">
              Relocate…
            </button>
            <InfoTip paragraphs={RELOCATE_INFO_PARAGRAPHS} className="shrink-0" />
            <span>
              · {photos.length} photo{photos.length === 1 ? "" : "s"}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex rounded-md border border-line text-xs">
            <button
              onClick={() => setView("gallery")}
              className={`rounded-l-md px-2.5 py-1 ${view === "gallery" ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-muted"}`}
            >
              Gallery
            </button>
            <button
              onClick={() => setView("species")}
              className={`rounded-r-md px-2.5 py-1 ${view === "species" ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-muted"}`}
            >
              Species view
            </button>
          </div>
          {view === "gallery" && photos.length > 0 && (
            <>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} className="accent-ink" />
                Labels
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                Size
                <input
                  type="range"
                  min={120}
                  max={800}
                  step={20}
                  value={thumbSizePx}
                  onChange={(e) => updateThumbSize(Number(e.target.value))}
                  className="w-24 accent-ink"
                  aria-label="Photo grid thumbnail size"
                />
              </label>
            </>
          )}
          <button
            onClick={startScan}
            disabled={scanning}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted disabled:opacity-50"
          >
            {scanning ? "Looking for photos…" : "Add more photos"}
          </button>
        </div>
      </header>

      {relocating && (
        <div className="border-b border-line bg-surface px-6 py-3">
          <FolderBrowser onChoose={applyRelocate} onCancel={() => setRelocating(false)} />
        </div>
      )}

      <div className="flex items-center gap-3 border-b border-line bg-surface px-6 py-2 text-sm">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search this trip's species…"
          className="w-56 rounded-md border border-line px-2 py-1 text-ink"
        />
        {search && (
          <button onClick={() => setSearch("")} className="text-muted hover:text-muted" aria-label="Clear search">
            ✕
          </button>
        )}
      </div>

      <main className="space-y-6 p-6">
        {relocateError && <p className="text-sm text-red-600">{relocateError}</p>}
        {scanError && <p className="text-sm text-red-600">{scanError}</p>}
        {scanStatus && !scanning && scanStatus.finishedAt && reviewRows.length === 0 && (
          <p className="text-sm text-muted">
            {scanStatus.recovered === 0 && scanStatus.relinked === 0 && scanStatus.markedStale === 0 && scanStatus.rawsLinked === 0
              ? "No new photos found."
              : ""}
            {scanStatus.recovered > 0 && ` ${scanStatus.recovered} photo${scanStatus.recovered === 1 ? "" : "s"} automatically recovered.`}
            {scanStatus.relinked > 0 && ` ${scanStatus.relinked} moved file${scanStatus.relinked === 1 ? "" : "s"} relinked.`}
            {scanStatus.markedStale > 0 && ` ${scanStatus.markedStale} missing (kept, marked stale).`}
            {scanStatus.rawsLinked > 0 && ` ${scanStatus.rawsLinked} RAW file${scanStatus.rawsLinked === 1 ? "" : "s"} linked.`}
            {scanStatus.error && <span className="text-red-600"> {scanStatus.error}</span>}
          </p>
        )}

        {reviewRows.length > 0 && (
          <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
            <div className="flex items-center gap-3 text-sm text-muted">
              <span>
                {reviewRows.length} new file{reviewRows.length === 1 ? "" : "s"} · {readyCount} ready to import
              </span>
              {selected.size > 0 && (
                <div className="flex items-center gap-2">
                  <span>Assign {selected.size} selected to:</span>
                  <div className="w-56">
                    <SpeciesPicker
                      placeholder="Type a species…"
                      onSelect={(r) => {
                        assignSpecies([...selected], r);
                        setSelected(new Set());
                      }}
                    />
                  </div>
                </div>
              )}
              <button
                onClick={importReady}
                disabled={importing || readyCount === 0}
                className="ml-auto rounded-md bg-accent px-3 py-1.5 text-accent-fg disabled:opacity-40"
              >
                {importing ? "Importing…" : `Import ${readyCount || ""} photo${readyCount === 1 ? "" : "s"}`}
              </button>
            </div>
            {importError && <p className="text-sm text-red-600">{importError}</p>}
            {importStatus && importing && (
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${importStatus.total ? Math.round((importStatus.processed / importStatus.total) * 100) : 0}%` }}
                />
              </div>
            )}

            <div className="divide-y divide-line rounded-lg border border-line bg-surface">
              {reviewRows.map((row) => (
                <div key={row.relativePath} className="flex items-center gap-3 p-3">
                  <input type="checkbox" checked={selected.has(row.relativePath)} onChange={() => toggleSelected(row.relativePath)} className="h-4 w-4" />
                  <img
                    src={`/api/trips/${id}/scan-preview?file=${encodeURIComponent(row.relativePath)}`}
                    alt=""
                    className="h-14 w-14 rounded-md object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{row.relativePath}</p>
                    {focusedRow === row.relativePath ? (
                      <div className="mt-1 w-64">
                        <SpeciesPicker autoFocus placeholder="Type a species…" onSelect={(r) => assignAndAdvance(row.relativePath, r)} />
                      </div>
                    ) : (
                      <button
                        onClick={() => setFocusedRow(row.relativePath)}
                        className={`mt-0.5 text-xs ${row.speciesId ? "text-ink" : "text-muted"} hover:underline`}
                      >
                        {row.speciesId ? row.speciesLabel : "Click to assign species…"}
                      </button>
                    )}
                  </div>
                  <span className="text-xs text-muted">
                    {row.status === "done" ? "✓ Imported" : row.status === "error" ? row.error : row.status === "importing" ? "Importing…" : ""}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {view === "species" ? (
          visibleSpecies.length === 0 ? (
            <p className="text-muted">{search ? `No species match "${search}".` : "No species collected on this trip yet."}</p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {visibleSpecies.map((item) => (
                <SpeciesCard key={item.speciesId} item={item} backLabel={trip?.name} showVolumeBadge={multiDriveInUse} />
              ))}
            </div>
          )
        ) : photos.length === 0 && pendingImports.length === 0 ? (
          <p className="text-muted">
            Nothing imported yet — {reviewRows.length === 0 ? '"Add more photos" to scan this trip\'s folder.' : "assign species above and import."}
          </p>
        ) : visiblePhotos.length === 0 && pendingImports.length === 0 ? (
          <p className="text-muted">No photos match "{search}".</p>
        ) : (
          <MasonryGrid
            items={gridItems}
            columnWidth={thumbSizePx}
            keyFor={(gi) => (gi.kind === "placeholder" ? `pending-${gi.key}` : gi.photo.photoId)}
            renderItem={(gi) => {
              if (gi.kind === "placeholder") {
                // A newly-added photo is still being processed (exif read, thumbnail
                // generation) — a greyed-out box with a spinner is more honest than either
                // making the user wait on the review table or showing nothing at all.
                return (
                  <div className="flex aspect-square w-full items-center justify-center rounded-md bg-surface-muted">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
                  </div>
                );
              }
              const { photo, photoIndex } = gi;
              const isCover = trip.coverCaptureId === photo.captureId;
              return (
                <div className="group relative">
                  <ProgressiveImg
                    thumbSrc={`/api/photos/${photo.photoId}/thumb`}
                    fullSrc={`/api/photos/${photo.photoId}/display`}
                    alt={photo.commonName ?? photo.scientificName}
                    onClick={() => setLightboxIndex(photoIndex)}
                    className="block w-full cursor-pointer rounded-md"
                  />
                  {showLabels && <p className="mt-1 truncate text-[11px] text-muted">{photo.commonName ?? photo.scientificName}</p>}
                  {/* Same "⋯" hover-menu pattern as SpeciesDetailPage's own photo gallery —
                     parity means the same interaction, not just the same end result. */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuCaptureId(openMenuCaptureId === photo.captureId ? null : photo.captureId);
                    }}
                    className="absolute right-1 top-1 rounded-full bg-black/40 px-1.5 text-xs text-white opacity-0 group-hover:opacity-100"
                    aria-label="Photo options"
                  >
                    ⋯
                  </button>
                  {openMenuCaptureId === photo.captureId && (
                    <div ref={openMenuRef} className="absolute right-1 top-7 z-10 whitespace-nowrap rounded-md border border-line bg-surface py-1 text-xs shadow-lg">
                      <button
                        onClick={() =>
                          isCover
                            ? setCover(null)
                            : setCoverAndEdit(photo.captureId, `/api/photos/${photo.photoId}/display`)
                        }
                        disabled={settingCover === photo.captureId}
                        className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                      >
                        {isCover ? "Featured photo ✓" : "Set as featured photo"}
                      </button>
                      {isCover && (
                        <button
                          onClick={() => {
                            setOpenMenuCaptureId(null);
                            setCroppingCoverPhotoUrl(`/api/photos/${photo.photoId}/display`);
                          }}
                          className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                        >
                          Adjust position
                        </button>
                      )}
                      {photo.hasRaw && (
                        <a
                          href={`/api/photos/${photo.photoId}/original-raw?download=1`}
                          onClick={() => setOpenMenuCaptureId(null)}
                          className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                        >
                          Download RAW
                        </a>
                      )}
                    </div>
                  )}
                </div>
              );
            }}
          />
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox slides={slides} index={lightboxIndex} onIndexChange={setLightboxIndex} onClose={() => setLightboxIndex(null)} />
      )}

      {croppingCoverPhotoUrl && (
        <CardCropEditor
          photoUrl={croppingCoverPhotoUrl}
          initialX={trip.coverCropX}
          initialY={trip.coverCropY}
          initialSize={trip.coverCropSize}
          onClose={() => setCroppingCoverPhotoUrl(null)}
          onSave={async (crop) => {
            await api.patch(`/trips/${id}/cover-crop`, crop);
            load();
          }}
          onReset={async () => {
            await api.patch(`/trips/${id}/cover-crop`, { reset: true });
            load();
          }}
        />
      )}
    </div>
  );
}
