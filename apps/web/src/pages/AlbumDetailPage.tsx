import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { AlbumPhoto, CollectionItem, QuadSlot } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { LoadingScreen, Spinner } from "../components/LoadingScreen";
import PasswordInput from "../components/PasswordInput";
import PageHeader from "../components/PageHeader";
import MasonryGrid from "../components/MasonryGrid";
import PhotoTile from "../components/PhotoTile";
import PhotoImportRows from "../components/PhotoImportRows";
import SpeciesCard from "../components/SpeciesCard";
import Lightbox, { photoFilePaths, type LightboxSlide } from "../components/Lightbox";
import CardCropEditor from "../components/CardCropEditor";
import { cropToImageStyle } from "../lib/crop";
import EditableTextField from "../components/EditableTextField";
import EmptyState from "../components/EmptyState";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
import { useShowLabels } from "../hooks/useShowLabels";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import Select from "../components/Select";
import { downloadFile } from "../lib/downloadFile";
import FilterPopover, { FilterFieldLabel } from "../components/FilterPopover";
import SegmentedControl from "../components/SegmentedControl";
import SelectModeToggle from "../components/SelectModeToggle";
import { usePersistedState } from "../hooks/usePersistedState";
import { useSelectMode } from "../hooks/useSelectMode";
import { useToast } from "../hooks/useToast";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import { formatDate } from "../lib/formatDate";

const SHARE_EXPIRY_OPTIONS = [
  { value: "never", label: "Never", days: null },
  { value: "1", label: "1 day", days: 1 },
  { value: "7", label: "7 days", days: 7 },
  { value: "30", label: "30 days", days: 30 },
] as const;
type ShareExpiry = (typeof SHARE_EXPIRY_OPTIONS)[number]["value"];

type AlbumView = "gallery" | "species";

interface AlbumDetail {
  id: string;
  name: string;
  description: string | null;
  coverPhotoId: string | null;
  coverLayout: "single" | "quad";
  coverCropX: number | null;
  coverCropY: number | null;
  coverCropSize: number | null;
  quadSlots: Array<QuadSlot | null>;
  items: AlbumPhoto[];
}

interface ShareLink {
  id: string;
  token: string;
  hasPassword: boolean;
  allowDownload: boolean;
  showMetadata: boolean;
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
}

export default function AlbumDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [thumbSizePx, setThumbSizePx] = usePhotoGridSize();
  const [showLabels, setShowLabels] = useShowLabels();
  // Sorting and filtering are client-side since the whole album loads at once. Unrated sorts as 3.
  const [sortBy, setSortBy] = usePersistedState<"newest" | "oldest" | "ratingHigh" | "ratingLow">("albumSortBy", "newest");
  const [mediaFilter, setMediaFilter] = usePersistedState<"both" | "photos" | "videos">("albumMediaFilter", "photos");
  const [rawFilter, setRawFilter] = usePersistedState<"any" | "with" | "without">("albumRawFilter", "without");
  const [onlyTopRated, setOnlyTopRated] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const { openKey: openMenuKey, setOpenKey: setOpenMenuKey, ref: openMenuRef } = useDropdownMenu<string>();
  const isServerMode = useDeploymentMode() === "server";
  const [view, setView] = useState<AlbumView>("gallery");
  const [speciesItems, setSpeciesItems] = useState<CollectionItem[] | null>(null);
  const [croppingCoverPhotoUrl, setCroppingCoverPhotoUrl] = useState<string | null>(null);
  // Cover controls and the edit toolbar stay hidden until asked for, keeping the grid uncluttered.
  const [editingCover, setEditingCover] = useState(false);
  const [editMode, setEditMode] = useState(false);
  // Imports link new captures into the album; files stay wherever the library stores them.
  const [showImportPanel, setShowImportPanel] = useState(false);
  // Which quad tile (0-3) is mid pick-a-photo or crop; only one at a time.
  const [pickingQuadSlot, setPickingQuadSlot] = useState<number | null>(null);
  const [croppingQuadSlot, setCroppingQuadSlot] = useState<number | null>(null);

  const [shares, setShares] = useState<ShareLink[] | null>(null);
  const [showSharePanel, setShowSharePanel] = useState(false);
  const [creatingShare, setCreatingShare] = useState(false);
  const [sharePassword, setSharePassword] = useState("");
  const [shareAllowDownload, setShareAllowDownload] = useState(false);
  const [shareShowMetadata, setShareShowMetadata] = useState(false);
  const [shareExpiry, setShareExpiry] = useState<ShareExpiry>("never");
  const [shareError, setShareError] = useState<string | null>(null);
  const toast = useToast();

  // Slides and the grid both derive from this array so the shared lightbox index stays correct.
  const sortedItems = useMemo(() => {
    if (!album) return [];
    const sorted =
      sortBy === "newest"
        ? album.items
        : [...album.items].sort((a, b) => {
            if (sortBy === "oldest") {
              return (a.takenAt ? new Date(a.takenAt).getTime() : 0) - (b.takenAt ? new Date(b.takenAt).getTime() : 0);
            }
            const ratingA = a.qualityRating ?? 3;
            const ratingB = b.qualityRating ?? 3;
            return sortBy === "ratingHigh" ? ratingB - ratingA : ratingA - ratingB;
          });
    return sorted
      .filter((item) => mediaFilter === "both" || (mediaFilter === "videos" ? item.kind === "video" : item.kind !== "video"))
      .filter((item) => rawFilter === "any" || (rawFilter === "with" ? item.hasRawOriginal : !item.hasRawOriginal))
      .filter((item) => !onlyTopRated || item.qualityRating === 5)
      .filter((item) => !dateFrom || !item.takenAt || item.takenAt >= dateFrom)
      .filter((item) => !dateTo || !item.takenAt || item.takenAt <= `${dateTo}T23:59:59`);
  }, [album, sortBy, mediaFilter, rawFilter, onlyTopRated, dateFrom, dateTo]);
  const select = useSelectMode(sortedItems, (item) => item.captureId);
  const { selectMode, selectedIds, dragPreviewIds, dragProps } = select;

  function load() {
    if (!id) return;
    setLoadError(false);
    api
      .get<AlbumDetail>(`/albums/${id}`)
      .then(setAlbum)
      .catch(() => setLoadError(true));
  }

  useEffect(load, [id]);

  useEffect(() => {
    if (!id || view !== "species") return;
    let cancelled = false;
    api
      .get<{ items: CollectionItem[] }>(`/albums/${id}/species`)
      .then((res) => {
        if (!cancelled) setSpeciesItems(res.items);
      })
      .catch(() => {
        if (cancelled) return;
        setSpeciesItems([]);
        toast.error("Couldn't load this album's species.");
      });
    return () => {
      cancelled = true;
    };
  }, [id, view, toast]);

  function loadShares() {
    if (!id) return;
    api
      .get<{ shares: ShareLink[] }>(`/albums/${id}/shares`)
      .then((res) => setShares(res.shares))
      .catch(() => toast.error("Couldn't load share links."));
  }

  // Runs an album PATCH, toasts on failure, then reloads. Crop saves skip this so CardCropEditor
  // can show the error and stay open.
  async function saveAndReload(request: () => Promise<unknown>, failure: string) {
    try {
      await request();
    } catch {
      toast.error(failure);
    }
    load();
  }

  async function removeFromAlbum(captureId: string) {
    if (!id) return;
    setAlbum((a) => (a ? { ...a, items: a.items.filter((i) => i.captureId !== captureId) } : a));
    try {
      await api.delete(`/albums/${id}/captures/${captureId}`);
    } catch {
      toast.error("Couldn't remove this photo from the album.");
      load();
    }
  }

  async function saveName(name: string) {
    if (!id || !name) return;
    await saveAndReload(() => api.patch(`/albums/${id}`, { name }), "Couldn't rename this album.");
  }

  async function saveDescription(description: string) {
    if (!id) return;
    await saveAndReload(() => api.patch(`/albums/${id}`, { description }), "Couldn't save the description.");
  }

  async function setCoverLayout(coverLayout: "single" | "quad") {
    if (!id) return;
    await saveAndReload(() => api.patch(`/albums/${id}`, { coverLayout }), "Couldn't change the cover style.");
  }

  async function setCoverPhoto(photoId: string) {
    if (!id) return;
    setOpenMenuKey(null);
    await saveAndReload(() => api.patch(`/albums/${id}`, { coverPhotoId: photoId }), "Couldn't set the album cover.");
  }

  async function saveCoverCrop(crop: { x: number; y: number; size: number }) {
    if (!id) return;
    await api.patch(`/albums/${id}/cover-crop`, crop);
    load();
  }

  async function resetCoverCrop() {
    if (!id) return;
    await api.patch(`/albums/${id}/cover-crop`, { reset: true });
    load();
  }

  async function setQuadSlotPhoto(slot: number, photoId: string | null) {
    if (!id) return;
    setPickingQuadSlot(null);
    await saveAndReload(() => api.patch(`/albums/${id}/quad-slot`, { slot, photoId }), "Couldn't change this cover tile.");
  }

  async function saveQuadSlotCrop(slot: number, crop: { x: number; y: number; size: number }) {
    if (!id) return;
    // Pins the slot to the photo shown, which may be an auto-picked fallback; otherwise the
    // resolver would discard the crop as a mismatch on the next load.
    const photoId = album?.quadSlots[slot]?.photoId ?? null;
    await api.patch(`/albums/${id}/quad-slot`, { slot, photoId, crop });
    load();
  }

  async function resetQuadSlotCrop(slot: number) {
    if (!id) return;
    await api.patch(`/albums/${id}/quad-slot`, { slot, crop: null });
    load();
  }

  async function createShare(e: FormEvent) {
    e.preventDefault();
    if (!id) return;
    setCreatingShare(true);
    setShareError(null);
    const days = SHARE_EXPIRY_OPTIONS.find((o) => o.value === shareExpiry)?.days ?? null;
    try {
      await api.post(`/albums/${id}/shares`, {
        password: sharePassword.trim() || undefined,
        allowDownload: shareAllowDownload,
        showMetadata: shareShowMetadata,
        expiresAt: days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null,
      });
      setSharePassword("");
      loadShares();
    } catch (err) {
      setShareError(err instanceof ApiError ? err.message : "Couldn't create this share link");
    } finally {
      setCreatingShare(false);
    }
  }

  async function revokeShare(shareId: string) {
    try {
      await api.delete(`/shares/${shareId}`);
    } catch {
      toast.error("Couldn't revoke this share link.");
    }
    loadShares();
  }

  function copyShareUrl(url: string) {
    // navigator.clipboard is missing on plain-http origins, e.g. a server reached over the LAN.
    (navigator.clipboard?.writeText(url) ?? Promise.reject()).then(
      () => toast.success("Link copied"),
      () => toast.error("Couldn't copy the link."),
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-muted">Couldn't load this album.</p>
        <Button variant="secondary" size="sm" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }
  if (!album) return <LoadingScreen />;

  const hasVideoInAlbum = album.items.some((i) => i.kind === "video");
  // Media and RAW filters count toward the badge only when off their default preset.
  const activeFilterCount =
    (onlyTopRated ? 1 : 0) +
    (mediaFilter !== "photos" ? 1 : 0) +
    (rawFilter !== "without" ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0);

  const slides: LightboxSlide[] = sortedItems.map((item) => ({
    url: `/api/photos/${item.photoId}/display`,
    videoUrl: item.kind === "video" ? `/api/photos/${item.photoId}/video` : null,
    caption: item.commonName || item.scientificName,
    info: {
      cameraModel: item.cameraModel,
      lens: item.lens,
      focalLengthMm: item.focalLengthMm,
      aperture: item.aperture,
      shutter: item.shutter,
      iso: item.iso,
      durationSeconds: item.durationSeconds,
      files: photoFilePaths(item.originalRef, item.rawRef),
    },
  }));

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader
        sticky
        title={
          <EditableTextField value={album.name} onSave={saveName} className="text-lg font-semibold text-ink" />
        }
        backFallbackTo="/albums"
        backLabel="Albums"
        actions={
          <>
            <div className="flex rounded-md border border-line text-sm">
              <button
                onClick={() => setView("gallery")}
                className={`rounded-l-md px-3 py-1.5 ${view === "gallery" ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-muted"}`}
              >
                Gallery
              </button>
              <button
                onClick={() => setView("species")}
                className={`rounded-r-md px-3 py-1.5 ${view === "species" ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-muted"}`}
              >
                Species view
              </button>
            </div>
            {view === "gallery" && (
              <>
                <Select label="Sort" value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="ratingHigh">Highest rated first</option>
                  <option value="ratingLow">Lowest rated first</option>
                </Select>
                <FilterPopover activeCount={activeFilterCount}>
                  <div className="space-y-2.5">
                    {hasVideoInAlbum && (
                      <div>
                        <FilterFieldLabel>Media type</FilterFieldLabel>
                        <SegmentedControl
                          value={mediaFilter}
                          onChange={setMediaFilter}
                          options={[
                            { value: "both", label: "Both" },
                            { value: "photos", label: "Photos" },
                            { value: "videos", label: "Videos" },
                          ]}
                        />
                      </div>
                    )}
                    <div>
                      <FilterFieldLabel>RAW files</FilterFieldLabel>
                      <SegmentedControl
                        value={rawFilter}
                        onChange={setRawFilter}
                        options={[
                          { value: "any", label: "Any" },
                          { value: "with", label: "With" },
                          { value: "without", label: "Without" },
                        ]}
                      />
                    </div>
                    <label className="flex items-center gap-1.5 text-xs text-ink">
                      <input type="checkbox" checked={onlyTopRated} onChange={(e) => setOnlyTopRated(e.target.checked)} className="accent-ink" />
                      Top rated
                    </label>
                    <div>
                      <FilterFieldLabel>Date</FilterFieldLabel>
                      {dateRangeOpen || dateFrom || dateTo ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="date"
                            value={dateFrom}
                            max={dateTo || undefined}
                            onChange={(e) => setDateFrom(e.target.value)}
                            className="w-full rounded-md border border-line px-1.5 py-1 text-xs text-ink"
                            aria-label="From date"
                          />
                          <span className="text-xs text-muted">to</span>
                          <input
                            type="date"
                            value={dateTo}
                            min={dateFrom || undefined}
                            onChange={(e) => setDateTo(e.target.value)}
                            className="w-full rounded-md border border-line px-1.5 py-1 text-xs text-ink"
                            aria-label="To date"
                          />
                        </div>
                      ) : (
                        <button
                          onClick={() => setDateRangeOpen(true)}
                          className="w-full rounded-md border border-line px-1.5 py-1 text-left text-xs text-muted hover:bg-surface-muted"
                        >
                          Any date
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="space-y-1.5 border-t border-line pt-2.5">
                    <label className="flex items-center gap-1.5 text-xs text-ink">
                      <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} className="accent-ink" />
                      Labels
                    </label>
                  </div>
                </FilterPopover>
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  Size
                  <input
                    type="range"
                    min={120}
                    max={800}
                    step={20}
                    value={thumbSizePx}
                    onChange={(e) => setThumbSizePx(Number(e.target.value))}
                    className="w-24 accent-ink"
                    aria-label="Photo grid thumbnail size"
                  />
                </label>
                <SelectModeToggle
                  active={selectMode}
                  onEnter={() => select.setSelectMode(true)}
                  onExit={select.exit}
                />
              </>
            )}
            <button
              onClick={() => setEditMode((v) => !v)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
                editMode ? "border-ink bg-surface-muted text-ink" : "border-line text-ink hover:bg-surface-muted"
              }`}
            >
              {editMode ? "Done editing" : "Edit album"}
            </button>
            {/* Desktop has no public URL to share, so sharing is server mode only. */}
            {isServerMode && (
              <button
                onClick={() => {
                  setShowSharePanel((s) => !s);
                  if (!shares) loadShares();
                }}
                className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted"
              >
                {showSharePanel ? "Hide sharing" : "Share…"}
              </button>
            )}
          </>
        }
      >
        <div className="mt-2 w-full">
          <EditableTextField
            value={album.description ?? ""}
            onSave={saveDescription}
            placeholder="Add a description…"
            className="text-sm text-ink"
            multiline
          />
        </div>
        {editMode && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Link
              to={`/gallery?select=1&albumId=${album.id}`}
              className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              Add photos
            </Link>
            <button
              onClick={() => setEditingCover((v) => !v)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
                editingCover ? "border-ink bg-surface-muted text-ink" : "border-line text-ink hover:bg-surface-muted"
              }`}
            >
              {editingCover ? "Done editing cover" : "Edit cover"}
            </button>
            <button onClick={() => setShowImportPanel((v) => !v)} className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted">
              Import album
            </button>
          </div>
        )}
      </PageHeader>

      {showImportPanel && id && (
        <div className="border-b border-line bg-surface-muted px-6 py-4">
          <PhotoImportRows
            albumId={id}
            onImported={() => {
              load();
              setShowImportPanel(false);
            }}
          />
        </div>
      )}

      {showSharePanel && isServerMode && (
        <div className="border-b border-line bg-surface-muted px-6 py-4">
          <div className="max-w-lg space-y-3">
            <form onSubmit={createShare} className="space-y-2 rounded-lg border border-line bg-surface p-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-ink">Password (optional)</label>
                <PasswordInput
                  value={sharePassword}
                  onChange={setSharePassword}
                  placeholder="Leave blank for no password"
                  autoComplete="new-password"
                  className="w-full rounded-md border border-line px-3 py-1.5 text-sm"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={shareAllowDownload} onChange={(e) => setShareAllowDownload(e.target.checked)} />
                Allow visitors to download photos
              </label>
              <div>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" checked={shareShowMetadata} onChange={(e) => setShareShowMetadata(e.target.checked)} />
                  Show camera info (lens, settings)
                </label>
                <p className="mt-0.5 pl-6 text-xs text-muted">Location data is never included in a shared link, regardless of this setting.</p>
              </div>
              <Select label="Link expires" value={shareExpiry} onChange={(e) => setShareExpiry(e.target.value as ShareExpiry)}>
                {SHARE_EXPIRY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <FormMessage error={shareError} />
              <Button type="submit" size="sm" loading={creatingShare}>
                {creatingShare ? "Creating…" : "Create share link"}
              </Button>
            </form>

            {shares && shares.length > 0 && (
              <ul className="space-y-2">
                {shares.map((share) => {
                  const url = `${window.location.origin}/share/${share.token}`;
                  const expired = !!share.expiresAt && new Date(share.expiresAt).getTime() < Date.now();
                  return (
                    <li
                      key={share.id}
                      className={`flex items-center justify-between gap-2 rounded-md border border-line bg-surface p-2 text-sm ${
                        share.revoked || expired ? "opacity-50" : ""
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="truncate">{share.revoked ? "Revoked" : expired ? "Expired" : url}</p>
                        <p className="text-xs text-muted">
                          {share.hasPassword ? "Password-protected" : "No password"}
                          {share.allowDownload ? " · Downloads allowed" : ""}
                          {share.expiresAt && !expired ? ` · Expires ${formatDate(share.expiresAt, "medium")}` : ""}
                        </p>
                      </div>
                      {!share.revoked && !expired && (
                        <div className="flex shrink-0 gap-2">
                          <button
                            onClick={() => copyShareUrl(url)}
                            className="rounded-md border border-line px-2 py-1 text-xs hover:bg-surface-muted"
                          >
                            Copy
                          </button>
                          <button
                            onClick={() => revokeShare(share.id)}
                            className="rounded-md border border-line px-2 py-1 text-xs text-red-600 hover:bg-surface-muted dark:text-red-400"
                          >
                            Revoke
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      <main className="p-6">
        {album.items.length === 0 ? (
          <EmptyState
            icon={
              <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <circle cx="9" cy="11" r="2" />
                <path d="m21 16-4.5-4.5L9 19" />
              </svg>
            }
            title="Nothing in this album yet"
            description="Add photos from the Gallery, a Trip, or a species page."
            action={{ label: "Add photos", onClick: () => navigate(`/gallery?select=1&albumId=${album.id}`) }}
          />
        ) : view === "species" ? (
          speciesItems == null ? (
            <Spinner />
          ) : speciesItems.length === 0 ? (
            <EmptyState
              icon={
                <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
              }
              title="No species in this album yet"
              description="Photos in this album haven't been identified to species."
            />
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {speciesItems.map((item) => (
                <SpeciesCard key={item.speciesId} item={item} backLabel={album.name} />
              ))}
            </div>
          )
        ) : (
          <>
            {editingCover && (
              <div className="mb-4">
                <div className="space-y-3 rounded-md border border-line bg-surface-muted p-3">
                  <div className="flex items-center gap-2 text-sm text-muted">
                    Cover style
                    <button
                      onClick={() => setCoverLayout("single")}
                      className={`rounded-md border px-2 py-1 text-xs ${
                        album.coverLayout === "single" ? "border-ink bg-surface text-ink" : "border-line hover:bg-surface"
                      }`}
                    >
                      Single photo
                    </button>
                    <button
                      onClick={() => setCoverLayout("quad")}
                      className={`rounded-md border px-2 py-1 text-xs ${
                        album.coverLayout === "quad" ? "border-ink bg-surface text-ink" : "border-line hover:bg-surface"
                      }`}
                    >
                      Quad grid
                    </button>
                  </div>
                  {album.coverLayout === "quad" && (
                    <div>
                      {pickingQuadSlot != null ? (
                        <p className="mb-2 text-xs text-muted">
                          Click a photo below to use it in this tile.{" "}
                          <button onClick={() => setPickingQuadSlot(null)} className="underline hover:text-ink">
                            Cancel
                          </button>
                        </p>
                      ) : (
                        <p className="mb-2 text-xs text-muted">Hover a tile to change its photo or crop.</p>
                      )}
                      <div className="grid w-48 grid-cols-2 grid-rows-2 gap-1">
                        {album.quadSlots.map((slot, i) => (
                          <div key={i} className="group relative aspect-square overflow-hidden rounded-md bg-surface">
                            {slot ? (
                              <img
                                src={`/api/photos/${slot.photoId}/thumb`}
                                alt=""
                                loading="lazy"
                                className="h-full w-full object-cover"
                                style={cropToImageStyle(slot.cropX, slot.cropY, slot.cropSize)}
                              />
                            ) : (
                              <div className="h-full w-full bg-surface-muted" />
                            )}
                            <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                              <button
                                onClick={() => setPickingQuadSlot(i)}
                                className="rounded-md bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-ink hover:bg-white"
                              >
                                Change
                              </button>
                              {slot && (
                                <button
                                  onClick={() => setCroppingQuadSlot(i)}
                                  className="rounded-md bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-ink hover:bg-white"
                                >
                                  Crop
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            {selectMode && selectedIds.size > 0 && (
              <div className="mb-3 flex items-center gap-3 rounded-md border border-line bg-surface-muted p-2 text-sm">
                <span className="text-muted">{selectedIds.size} selected</span>
                <button
                  onClick={async () => {
                    const ids = [...selectedIds];
                    select.clear();
                    for (const captureId of ids) await removeFromAlbum(captureId);
                  }}
                  className="text-red-600 hover:underline dark:text-red-400"
                >
                  Remove from album
                </button>
              </div>
            )}
            <MasonryGrid
              items={sortedItems.map((item, i) => ({ item, i }))}
              columnWidth={thumbSizePx}
              gap={8}
              extraHeightPx={showLabels ? 19 : 0}
              keyFor={({ item }) => item.photoId}
              aspectRatioFor={({ item }) => (item.width && item.height ? item.width / item.height : null)}
              renderItem={({ item, i }, aspectRatio) => {
                const isCover = album.coverPhotoId === item.photoId;
                return (
                  <PhotoTile
                    key={item.photoId}
                    photoId={item.photoId}
                    alt={item.commonName || item.scientificName}
                    onOpen={() => (pickingQuadSlot != null ? setQuadSlotPhoto(pickingQuadSlot, item.photoId) : setLightboxIndex(i))}
                    selectMode={selectMode}
                    selected={selectedIds.has(item.captureId) || (dragPreviewIds?.has(item.captureId) ?? false)}
                    onToggleSelect={(shiftKey) => select.toggle(item.captureId, i, shiftKey)}
                    onDragSelectStart={() => dragProps.onDragSelectStart(i)}
                    onDragSelectEnter={() => dragProps.onDragSelectEnter(i)}
                    aspectRatio={aspectRatio}
                    kind={item.kind}
                    durationSeconds={item.durationSeconds != null ? Number(item.durationSeconds) : null}
                    menuOpen={openMenuKey === item.photoId}
                    onToggleMenu={() => setOpenMenuKey(openMenuKey === item.photoId ? null : item.photoId)}
                    menuRef={openMenuRef}
                    menuContent={
                      openMenuKey === item.photoId && <div className="absolute right-0 top-full z-10 mt-1 w-44 rounded-md border border-line bg-surface py-1 shadow-lg">
                        {item.speciesId && (
                          <Link
                            to={`/species/${item.speciesId}`}
                            onClick={() => setOpenMenuKey(null)}
                            className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                          >
                            View species
                          </Link>
                        )}
                        <button
                          onClick={() => setCoverPhoto(item.photoId)}
                          disabled={isCover}
                          className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
                        >
                          {isCover ? "Album cover ✓" : "Set as album cover"}
                        </button>
                        {isCover && album.coverLayout === "single" && (
                          <button
                            onClick={() => {
                              setOpenMenuKey(null);
                              setCroppingCoverPhotoUrl(`/api/photos/${item.photoId}/display`);
                            }}
                            className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                          >
                            Adjust position
                          </button>
                        )}
                        {/* Hidden when the only original on file is the RAW. */}
                        {item.originalRef && item.originalKind !== "raw" && (
                          <button
                            onClick={() => {
                              setOpenMenuKey(null);
                              downloadFile(`/api/photos/${item.photoId}/original?download=1`, "original.jpg");
                            }}
                            className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                          >
                            Download original
                          </button>
                        )}
                        {item.hasRawOriginal && (
                          <button
                            onClick={() => {
                              setOpenMenuKey(null);
                              downloadFile(`/api/photos/${item.photoId}/original-raw?download=1`, "original.raw");
                            }}
                            className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                          >
                            Download RAW
                          </button>
                        )}
                        <button
                          onClick={() => {
                            removeFromAlbum(item.captureId);
                            setOpenMenuKey(null);
                          }}
                          className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-surface-muted dark:text-red-400"
                        >
                          Remove from album
                        </button>
                      </div>
                    }
                    label={
                      showLabels && <p className="mt-1 truncate text-[11px] text-muted">{item.commonName || item.scientificName}</p>
                    }
                  />
                );
              }}
            />
          </>
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox slides={slides} index={lightboxIndex} onIndexChange={setLightboxIndex} onClose={() => setLightboxIndex(null)} />
      )}

      {croppingCoverPhotoUrl && (
        <CardCropEditor
          photoUrl={croppingCoverPhotoUrl}
          initialX={album.coverCropX}
          initialY={album.coverCropY}
          initialSize={album.coverCropSize}
          onClose={() => setCroppingCoverPhotoUrl(null)}
          onSave={saveCoverCrop}
          onReset={resetCoverCrop}
        />
      )}

      {croppingQuadSlot != null && album.quadSlots[croppingQuadSlot] && (
        <CardCropEditor
          photoUrl={`/api/photos/${album.quadSlots[croppingQuadSlot]!.photoId}/display`}
          initialX={album.quadSlots[croppingQuadSlot]!.cropX}
          initialY={album.quadSlots[croppingQuadSlot]!.cropY}
          initialSize={album.quadSlots[croppingQuadSlot]!.cropSize}
          onClose={() => setCroppingQuadSlot(null)}
          onSave={async (crop) => {
            await saveQuadSlotCrop(croppingQuadSlot, crop);
            setCroppingQuadSlot(null);
          }}
          onReset={async () => {
            await resetQuadSlotCrop(croppingQuadSlot);
            setCroppingQuadSlot(null);
          }}
        />
      )}
    </div>
  );
}
