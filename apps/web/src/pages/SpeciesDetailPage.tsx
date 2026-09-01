import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import UploadDropzone from "../components/UploadDropzone";
import RawUpload from "../components/RawUpload";
import StarRating from "../components/StarRating";
import { useVolumeDestination, VolumeDestinationPicker } from "../components/VolumeDestinationPicker";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import CardCropEditor from "../components/CardCropEditor";
import SeasonalityBar from "../components/SeasonalityBar";
import SpeciesPicker from "../components/SpeciesPicker";
import ProgressiveImg from "../components/ProgressiveImg";
import BackToCollectionLink from "../components/BackToCollectionLink";
import { LoadingScreen } from "../components/LoadingScreen";
import PhotoPlaceholder from "../components/PhotoPlaceholder";
import MasonryGrid from "../components/MasonryGrid";
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
import { useUploadQueue } from "../lib/uploadQueue";
import { shotDataLine } from "../lib/shotData";

// GET /api/species/:id/unmatched-raws — RAWs filed under this species with no capture (see
// loadUnmatchedRaws' own comment).
interface UnmatchedRaw {
  id: string;
  filename: string | null;
  fileSize: number;
  addedAt: string;
  previewUrl: string;
  downloadUrl: string;
}

// The raw shape returned by GET /api/species/:id — direct SQL rows, snake_case, joined
// across species/species_traits/species_rarity/captures/photos/user_species.
interface SpeciesDetail {
  species: {
    id: string;
    scientific_name: string;
    common_name: string | null;
    inat_taxon_id: number | null;
    ebird_code: string | null;
    taxon_class: string | null;
    mass_g: string | null;
    wingspan_mm: string | null;
    trophic_niche: string | null;
    primary_lifestyle: string | null;
    nocturnal: boolean | null;
    home_range_km2: string | null;
    depth_min_m: string | null;
    depth_max_m: string | null;
    domestic: boolean | null;
    iucn_status: string | null;
    tier: string | null;
    reference_photo: string | null;
    /** Ready-to-use — prefers the cached local copy, falls back to the external URL (see
     *  conversation). Always use this, not reference_photo, for rendering. */
    reference_photo_url: string | null;
    reference_credit: string | null;
    reference_focal_x: number | string | null;
    reference_focal_y: number | string | null;
    description: string | null;
    description_credit: string | null;
    description_source_url: string | null;
    habitat_description: string | null;
  };
  captures: Array<{
    id: string;
    photo_id: string | null;
    width: number | null;
    height: number | null;
    taken_at: string | null;
    camera_model: string | null;
    lens: string | null;
    focal_length_mm: string | null;
    aperture: string | null;
    shutter: string | null;
    iso: number | null;
    quality_rating: number | null;
    original_ref: string | null;
    original_managed: boolean | null;
    original_kind: string | null;
    original_available: boolean | null;
    /** Which registered external drive holds this original, set only when original_available
     *  is false because that drive isn't connected right now (see storageVolumes) — null for
     *  a genuinely missing file, or one that's on the always-on primary drive. */
    original_volume_label: string | null;
    has_raw_original: boolean;
  }>;
  userSpecies: {
    state: "collected" | "seen";
    cover_photo_id: string | null;
    card_crop_x: string | number | null;
    card_crop_y: string | number | null;
    card_crop_size: string | number | null;
    best_quality: number | null;
  } | null;
  referencePhotos: Array<{
    photo_url: string;
    credit: string;
    license: string;
    focal_x: number | string | null;
    focal_y: number | string | null;
  }>;
  seasonality: number[] | null;
  localTier: string | null;
  isVagrant: boolean;
  endemicCountryName: string | null;
  isArchived: boolean;
}

// "Show me this photo big" prefers the full-resolution original when one exists (store or
// link mode — see the originals feature); falls back to the 2560px display WebP for
// captures predating it, AND for one whose original is known unavailable right now (a
// disconnected external drive, or a genuinely missing file) — otherwise the lightbox would
// request a 404/409 and show a broken image instead of the still-perfectly-viewable display
// copy. RAW originals (Phase 7, not yet possible) would need to keep using /display instead,
// since browsers can't render RAW.
function fullSizeUrl(capture: { photo_id: string | null; original_ref: string | null; original_kind: string | null; original_available: boolean | null }) {
  if (!capture.photo_id) return null;
  if (capture.original_ref && capture.original_kind === "jpeg" && capture.original_available !== false) {
    return `/api/photos/${capture.photo_id}/original`;
  }
  return `/api/photos/${capture.photo_id}/display`;
}


export default function SpeciesDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { jobs: uploadJobs } = useUploadQueue();
  const pendingUploadCount = uploadJobs.filter((j) => j.speciesId === id && !j.done).length;
  const [searchParams] = useSearchParams();
  const regionId = searchParams.get("regionId");
  const [detail, setDetail] = useState<SpeciesDetail | null>(null);
  const [lightbox, setLightbox] = useState<{ slides: LightboxSlide[]; index: number } | null>(null);
  const [openMenuCaptureId, setOpenMenuCaptureId] = useState<string | null>(null);
  const [taggingCaptureId, setTaggingCaptureId] = useState<string | null>(null);
  const [croppingCover, setCroppingCover] = useState(false);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedCaptureIds, setSelectedCaptureIds] = useState<Set<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // "Correct the ID" — reassigns a mis-identified photo (or a whole batch of them) to a
  // different species after the fact. Reuses PATCH /captures/:id/reassign per-capture (there's
  // no batch endpoint for this — the set of reassignments is small and interactive, so a
  // Promise.all loop is simpler than adding a new bulk route).
  const [reassigningCaptureId, setReassigningCaptureId] = useState<string | null>(null);
  const [batchReassigning, setBatchReassigning] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);
  const [deleteRawToo, setDeleteRawToo] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Target thumbnail width in px, fed to MasonryGrid instead of fixed Tailwind breakpoint
  // column counts, so it's a true continuous size control rather than a handful of discrete
  // column-count steps. Shared with GalleryPage via the same localStorage key (see
  // usePhotoGridSize's own comment) so both pages stay in sync.
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  const volumeDestination = useVolumeDestination(id ?? "");

  // "Gallery view" hides rarity tier/rating and camera/EXIF info, for showing off the photos
  // themselves (to someone else, or on a big screen) without the app's own bookkeeping
  // cluttering it. Persisted across species/reloads (same localStorage pattern as
  // CollectionPage's last-region cache) rather than reset per page, so browsing several
  // species in a row doesn't flip it back on each time.
  const [galleryView, setGalleryView] = useState(() => {
    try {
      return localStorage.getItem("lifer:galleryView") === "true";
    } catch {
      return false;
    }
  });
  // Edited vs RAW-only view filter — state declared here (near the other view toggles);
  // derived counts (editedCount/rawOnlyCount) are computed further down, once `captures` is
  // actually in scope.
  const [photoFilter, setPhotoFilter] = useState<"all" | "edited" | "raw">("edited");

  function toggleGalleryView() {
    setGalleryView((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("lifer:galleryView", String(next));
      } catch {
        // Private browsing or storage disabled — the toggle still works for this page view,
        // it just won't be remembered next time.
      }
      return next;
    });
  }

  // The photo-options "⋯" menu should close on a click anywhere else on the page, not just
  // its own toggle button. The toggle button's own click already calls
  // stopPropagation (see below), so this document-level listener never sees that click and
  // can't immediately re-close a menu the same click just opened. Scoped to clicks OUTSIDE
  // the menu itself (via openMenuRef, attached to whichever menu is currently rendered) —
  // the menu can contain its own interactive content (the "also features another species"
  // picker's text input), which needs clicks to reach it rather than closing the menu first.
  const openMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openMenuCaptureId) return;
    const closeIfOutside = (e: MouseEvent) => {
      if (openMenuRef.current && !openMenuRef.current.contains(e.target as Node)) {
        setOpenMenuCaptureId(null);
      }
    };
    document.addEventListener("click", closeIfOutside);
    return () => document.removeEventListener("click", closeIfOutside);
  }, [openMenuCaptureId]);

  // A RAW file browser with the same "⋯" menu pattern as the photo grid above, just its own
  // independent open/close state since it's a separate list.
  const [openRawMenuId, setOpenRawMenuId] = useState<string | null>(null);
  const openRawMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openRawMenuId) return;
    const closeIfOutside = (e: MouseEvent) => {
      if (openRawMenuRef.current && !openRawMenuRef.current.contains(e.target as Node)) {
        setOpenRawMenuId(null);
      }
    };
    document.addEventListener("click", closeIfOutside);
    return () => document.removeEventListener("click", closeIfOutside);
  }, [openRawMenuId]);

  const load = useCallback(() => {
    if (!id) return;
    setLoadError(false);
    const query = regionId ? `?regionId=${regionId}` : "";
    // A dropped request otherwise leaves `detail` stuck at null forever with no way back —
    // surface it instead of silently hanging on "Loading…".
    api
      .get<SpeciesDetail>(`/species/${id}${query}`)
      .then(setDetail)
      .catch(() => setLoadError(true));
  }, [id, regionId]);

  // RAWs filed straight into this species' RAW folder without a matching JPEG (see
  // RawUpload's allowUnmatchedFallback) have no capture to show up in the photo grid above,
  // so they get their own small list instead of only existing on disk with no way to find
  // them again.
  const [unmatchedRaws, setUnmatchedRaws] = useState<UnmatchedRaw[]>([]);
  const loadUnmatchedRaws = useCallback(() => {
    if (!id) return;
    api
      .get<{ rawFiles: UnmatchedRaw[] }>(`/species/${id}/unmatched-raws`)
      .then((res) => setUnmatchedRaws(res.rawFiles))
      .catch(() => setUnmatchedRaws([]));
  }, [id]);

  useEffect(() => {
    load();
    loadUnmatchedRaws();
  }, [load, loadUnmatchedRaws]);

  // A drive that was disconnected when this page first loaded might get plugged back in while
  // you're still sitting here — without this, "connect the drive" only ever gets rechecked by
  // leaving and coming back to the page. Only polls while it's actually relevant (at least one
  // capture currently reads as unavailable), and stops as soon as everything resolves.
  const hasUnavailableOriginal = detail?.captures.some((c) => c.original_available === false) ?? false;
  useEffect(() => {
    if (!hasUnavailableOriginal) return;
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [hasUnavailableOriginal, load]);

  // React Router doesn't reset scroll position on navigation by itself — without this,
  // clicking from a long-scrolled species page into another species (or hitting back/forward
  // between two of them) lands wherever the browser happened to leave the scroll offset, which
  // reads as "landing in the middle of a random photo gallery" rather than at the species'
  // own header/hero photo.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id]);

  // Your own cover photo first (if you have one), then the Phase-1 reference gallery
  // (Wikipedia media -> Commons) as alternates to arrow through and compare against.
  const heroSlides = useMemo<LightboxSlide[]>(() => {
    if (!detail) return [];
    const { species, userSpecies, referencePhotos, captures } = detail;
    const slides: LightboxSlide[] = [];

    const coverCapture = captures.find((c) => c.photo_id === userSpecies?.cover_photo_id);
    if (userSpecies?.cover_photo_id && coverCapture) {
      slides.push({ url: fullSizeUrl(coverCapture)!, caption: "Your photo" });
    } else if (species.reference_photo_url) {
      // focalX/Y (migration 043) — a stored focal point for the shared reference photo,
      // applied via object-position wherever this slide shows in a cropped box (the hero
      // below); never meaningful for your own cover photo above, which has no such column.
      slides.push({
        url: species.reference_photo_url,
        caption: species.reference_credit,
        focalX: species.reference_focal_x == null ? null : Number(species.reference_focal_x),
        focalY: species.reference_focal_y == null ? null : Number(species.reference_focal_y),
      });
    }

    for (const p of referencePhotos) {
      // A gallery row can exist with no actual file behind it (a failed fetch that still left
      // a placeholder row instead of being cleaned up) — pushing it in anyway would put a
      // slide with nothing to show into the arrow-through order for no reason.
      if (!p.photo_url) continue;
      if (p.photo_url === species.reference_photo_url && !userSpecies?.cover_photo_id) continue;
      slides.push({
        url: p.photo_url,
        caption: p.credit,
        focalX: p.focal_x == null ? null : Number(p.focal_x),
        focalY: p.focal_y == null ? null : Number(p.focal_y),
      });
    }
    return slides;
  }, [detail]);

  const [heroIndex, setHeroIndex] = useState(0);
  useEffect(() => setHeroIndex(0), [heroSlides.length]);
  // A reference photo whose file has since moved or been deleted would otherwise show the
  // browser's own broken-image icon — falls back to the same "no photo" placeholder instead.
  const [heroPhotoFailed, setHeroPhotoFailed] = useState(false);
  useEffect(() => setHeroPhotoFailed(false), [heroIndex, heroSlides.length]);

  // Both the error and still-loading states previously skipped the header entirely, leaving
  // no way back except closing the tab/window — the header (and its BackToCollectionLink) now
  // renders unconditionally, with only the body swapping between error/loading/loaded.
  if (loadError) {
    return (
      <div className="min-h-screen bg-canvas">
        <header className="page-header border-b border-line bg-surface px-6 py-4">
          <BackToCollectionLink fallbackTo={regionId ? `/?region=${regionId}` : "/"} className="text-sm text-muted hover:underline" />
        </header>
        <div className="p-8 text-muted">
          Couldn't load this species.{" "}
          <button onClick={load} className="text-ink underline">
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="min-h-screen bg-canvas">
        <header className="page-header border-b border-line bg-surface px-6 py-4">
          <BackToCollectionLink fallbackTo={regionId ? `/?region=${regionId}` : "/"} className="text-sm text-muted hover:underline" />
        </header>
        <LoadingScreen showBackLink={false} />
      </div>
    );
  }
  const { species, captures } = detail;

  async function setCover(photoId: string) {
    setOpenMenuCaptureId(null);
    await api.patch(`/species/${id}/cover`, { photoId });
    load();
  }

  async function markSeen() {
    await api.patch(`/species/${id}/seen`);
    load();
  }

  async function unmarkSeen() {
    await api.delete(`/species/${id}/seen`);
    load();
  }

  async function archive() {
    try {
      await api.post(`/species/${id}/archive`);
      load();
    } catch {
      alert("Couldn't archive this species — try again.");
    }
  }

  async function unarchive() {
    try {
      await api.delete(`/species/${id}/archive`);
      load();
    } catch {
      alert("Couldn't unarchive this species — try again.");
    }
  }

  async function revealInFinder(path: string) {
    setOpenMenuCaptureId(null);
    await api.post("/originals/reveal", { path }).catch(() => alert("Couldn't reveal that file — it may be unavailable."));
  }

  async function rateCapture(captureId: string, rating: number | null) {
    await api.patch(`/captures/${captureId}/rating`, { rating });
    load();
  }

  // Single-photo delete reuses the same confirmation dialog as the multi-select batch delete
  // below — one dialog, one place to get the trash-retention wording right, instead of a plain
  // native confirm() here duplicating (and inevitably drifting from) that copy.
  function requestDeleteCapture(captureId: string) {
    setOpenMenuCaptureId(null);
    setSelectedCaptureIds(new Set([captureId]));
    setConfirmingDelete(true);
  }

  function toggleSelected(captureId: string) {
    setSelectedCaptureIds((prev) => {
      const next = new Set(prev);
      if (next.has(captureId)) next.delete(captureId);
      else next.add(captureId);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedCaptureIds(new Set());
  }

  // Only offered when at least one selected photo actually has one to delete — asking every
  // time, even for a batch with no RAWs at all, would be a pointless extra click most of the
  // time.
  const selectedHaveRaw = captures.some((c) => selectedCaptureIds.has(c.id) && c.has_raw_original);
  // See photoFilter's own declaration above for why "edited" means original_kind !== "raw".
  const editedCount = captures.filter((c) => c.photo_id && c.original_kind !== "raw").length;
  const rawOnlyCount = captures.filter((c) => c.photo_id && c.original_kind === "raw").length;

  async function confirmDeleteSelected() {
    setDeleting(true);
    try {
      await api.post("/captures/batch-delete", { captureIds: [...selectedCaptureIds], deleteRaw: deleteRawToo });
      setConfirmingDelete(false);
      setDeleteRawToo(false);
      exitSelectMode();
      load();
    } finally {
      setDeleting(false);
    }
  }

  // Marks a photo as also containing another species (e.g. a hawk catching a fish) — the
  // tagged species counts as fully collected too, and this same photo then shows up on its
  // detail page as well (see species/routes.ts's captures query, which also matches via
  // capture_species).
  async function reassignSpecies(captureId: string, newSpeciesId: string) {
    setReassigningCaptureId(null);
    setOpenMenuCaptureId(null);
    setReassignError(null);
    try {
      await api.patch(`/captures/${captureId}/reassign`, { speciesId: newSpeciesId });
      load();
    } catch (err) {
      setReassignError(err instanceof ApiError ? err.message : "Couldn't reassign this photo");
    }
  }

  async function reassignSelected(newSpeciesId: string) {
    setBatchReassigning(true);
    setReassignError(null);
    try {
      const results = await Promise.allSettled(
        [...selectedCaptureIds].map((captureId) => api.patch(`/captures/${captureId}/reassign`, { speciesId: newSpeciesId })),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) setReassignError(`${failed} of ${results.length} photos couldn't be reassigned`);
      exitSelectMode();
      load();
    } finally {
      setBatchReassigning(false);
    }
  }

  async function tagSpecies(captureId: string, otherSpeciesId: string) {
    setTaggingCaptureId(null);
    setOpenMenuCaptureId(null);
    await api.post(`/captures/${captureId}/species`, { speciesId: otherSpeciesId }).catch((err) =>
      alert(err instanceof ApiError ? err.message : "Couldn't tag that species"),
    );
    load();
  }

  const captureSlides: LightboxSlide[] = captures
    .filter((c) => c.photo_id)
    .map((c) => ({
      url: fullSizeUrl(c)!,
      caption: c.taken_at ? new Date(c.taken_at).toLocaleDateString() : null,
      info: {
        cameraModel: c.camera_model,
        lens: c.lens,
        focalLengthMm: c.focal_length_mm,
        aperture: c.aperture,
        shutter: c.shutter,
        iso: c.iso,
        takenAt: c.taken_at,
      },
    }));

  return (
    <div className="min-h-screen bg-canvas">
      {/* Sticky rather than the collection page's normal in-flow header — this page is long
         enough (hero photo + full gallery) that losing the back link off the top of the
         viewport made it easy to end up scrolled a long way down with no quick way back up
         to it. z-20 keeps it above the page content but still under the mac title-bar drag
         strip's own z-index (see index.css). */}
      <header className="page-header sticky top-0 z-20 border-b border-line bg-surface px-6 py-4">
        <BackToCollectionLink
          fallbackTo={regionId ? `/?region=${regionId}` : "/"}
          className="text-sm text-muted hover:underline"
        />
      </header>

      {/* <main> itself is full width (the photo grid below spreads out across it, keeping
         the masonry/progressive-loading layout), while the reference photo and species info
         sit in their own centered narrow column rather than sharing in that width. */}
      <main className="w-full space-y-6 p-6">
        {/* 48rem (3xl) * 1.3 ≈ 62.4rem. */}
        <div className="mx-auto max-w-[62.4rem] space-y-6">
        {heroSlides.length === 0 ? (
          <PhotoPlaceholder className="aspect-[16/9]" />
        ) : heroPhotoFailed ? (
          <PhotoPlaceholder className="aspect-[16/9]" />
        ) : (
          // Fills this wrapper's own width, same as the description text below it, rather
          // than being capped to a separate width.
          <figure className="relative">
            <img
              src={heroSlides[heroIndex].url}
              alt={species.common_name ?? species.scientific_name}
              onClick={() => setLightbox({ slides: heroSlides, index: heroIndex })}
              className="aspect-[16/9] w-full cursor-pointer rounded-lg object-cover"
              style={{
                objectPosition: `${heroSlides[heroIndex].focalX ?? 50}% ${heroSlides[heroIndex].focalY ?? 50}%`,
              }}
              onError={() => setHeroPhotoFailed(true)}
            />
            {heroSlides.length > 1 && (
              <>
                <button
                  onClick={() => setHeroIndex((i) => (i - 1 + heroSlides.length) % heroSlides.length)}
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/30 px-2.5 py-1 text-lg text-white hover:bg-black/50"
                  aria-label="Previous reference photo"
                >
                  ‹
                </button>
                <button
                  onClick={() => setHeroIndex((i) => (i + 1) % heroSlides.length)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/30 px-2.5 py-1 text-lg text-white hover:bg-black/50"
                  aria-label="Next reference photo"
                >
                  ›
                </button>
                <span className="absolute bottom-[28px] right-2 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white">
                  {heroIndex + 1} / {heroSlides.length}
                </span>
              </>
            )}
            {heroSlides[heroIndex].caption && (
              <figcaption className="mt-1 text-[11px] text-muted">{heroSlides[heroIndex].caption}</figcaption>
            )}
          </figure>
        )}

        <div>
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-ink">{species.common_name ?? species.scientific_name}</h1>
              <p className="italic text-muted">{species.scientific_name}</p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {detail.userSpecies?.cover_photo_id && (
                <button onClick={() => setCroppingCover(true)} className="text-xs text-muted hover:underline">
                  Adjust card preview
                </button>
              )}
              {detail.userSpecies?.state === "seen" ? (
                <button onClick={unmarkSeen} className="text-xs text-muted hover:underline">
                  ✓ Seen (undo)
                </button>
              ) : !detail.userSpecies ? (
                <button onClick={markSeen} className="text-xs text-muted hover:underline">
                  Mark as seen
                </button>
              ) : null}
              {/* Archived species are excluded from checklists (see NOT_ARCHIVED_SQL) but stay
                 reachable via search/this page, exactly so they can be unarchived here — the
                 button always reflects the real archived row, not the exemption that lets a
                 collected species stay visible despite one existing. */}
              {detail.isArchived ? (
                <button onClick={unarchive} className="text-xs text-muted hover:underline">
                  Archived (unarchive)
                </button>
              ) : detail.userSpecies?.state !== "collected" ? (
                <button onClick={archive} className="text-xs text-muted hover:underline">
                  Archive
                </button>
              ) : null}
            </div>
          </div>
          {!galleryView && (species.tier || detail.localTier || detail.endemicCountryName || detail.isVagrant) && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {species.tier && (
                <span
                  className={
                    species.tier === "unrated"
                      ? "inline-block rounded-full border border-dashed border-line px-2 py-0.5 text-xs uppercase tracking-wide text-muted"
                      : "inline-block rounded-full bg-surface-muted px-2 py-0.5 text-xs uppercase tracking-wide text-muted"
                  }
                  title={species.tier === "unrated" ? "Not enough data yet to rate how hard this is to find" : undefined}
                >
                  {species.tier === "unrated" ? "Unrated" : species.tier}
                </span>
              )}
              {detail.localTier && (
                <span
                  className="inline-block rounded-full border border-line px-2 py-0.5 text-xs uppercase tracking-wide text-muted"
                  title="Rarity ranked against other species in this region specifically"
                >
                  {detail.localTier} here
                </span>
              )}
              {detail.endemicCountryName && (
                <span
                  className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs uppercase tracking-wide text-amber-700"
                  title="Only ever recorded (real GBIF presence) in this one country"
                >
                  Endemic to {detail.endemicCountryName}
                </span>
              )}
              {detail.isVagrant && (
                <span
                  className="inline-block rounded-full bg-sky-100 px-2 py-0.5 text-xs uppercase tracking-wide text-sky-700"
                  title="Records here are concentrated in very few years — likely a vagrant, not an established local presence"
                >
                  Vagrant here
                </span>
              )}
            </div>
          )}
        </div>

        <SeasonalityBar seasonality={detail.seasonality} />
        {species.description && (
          <p className="text-sm text-ink">
            {species.description}{" "}
            {species.description_source_url && (
              <a href={species.description_source_url} target="_blank" rel="noreferrer" className="text-muted hover:underline">
                (Wikipedia)
              </a>
            )}
          </p>
        )}
        {species.habitat_description && (
          <p className="text-sm text-ink">
            <span className="font-medium text-muted">Habitat: </span>
            {species.habitat_description}
          </p>
        )}

        {/* Per-taxon stats — wingspan/niche only ever had real data for
           birds (AVONET/EltonTraits), so showing them for mammals/fish was always just a
           blank "—" that implied a bird-shaped trait set applies to every taxon. Each taxon
           shows only the axes it actually has a real source for. */}
        <dl className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface p-4 text-sm sm:grid-cols-4">
          {species.taxon_class === "aves" && (
            <>
              <Stat label="Mass" value={species.mass_g ? formatMass(Number(species.mass_g)) : "—"} />
              <Stat label="Wingspan" value={species.wingspan_mm ? `${Math.round(Number(species.wingspan_mm))} mm` : "—"} />
              <Stat label="Niche" value={species.trophic_niche ?? "—"} />
            </>
          )}
          {species.taxon_class === "mammalia" && (
            <>
              <Stat label="Mass" value={species.mass_g ? formatMass(Number(species.mass_g)) : "—"} />
              <Stat label="Home range" value={species.home_range_km2 ? `${Math.round(Number(species.home_range_km2))} km²` : "—"} />
              <Stat label="Nocturnal" value={species.nocturnal == null ? "—" : species.nocturnal ? "Yes" : "No"} />
              {species.domestic && <Stat label="Domestic" value="Yes" />}
            </>
          )}
          {species.taxon_class === "actinopterygii" && (
            <Stat
              label="Depth range"
              value={
                species.depth_min_m != null && species.depth_max_m != null
                  ? `${Math.round(Number(species.depth_min_m))}-${Math.round(Number(species.depth_max_m))} m`
                  : "—"
              }
            />
          )}
          <Stat label="IUCN" value={species.iucn_status ?? "—"} />
        </dl>

        <div className="flex flex-wrap gap-4 text-sm">
          {species.inat_taxon_id && (
            <a
              href={`https://www.inaturalist.org/taxa/${species.inat_taxon_id}`}
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:underline"
            >
              View on iNaturalist ↗
            </a>
          )}
          {species.ebird_code && (
            <a
              href={`https://ebird.org/species/${species.ebird_code}`}
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:underline"
            >
              View on eBird ↗
            </a>
          )}
        </div>
        </div>

        <section>
          <div className="mb-2 flex items-center justify-between gap-4">
            <h2 className="text-sm font-medium text-ink">Your photos</h2>
            <div className="flex items-center gap-4">
              {captures.length > 0 && (
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
              )}
              <button
                onClick={toggleGalleryView}
                className={`text-xs hover:underline ${galleryView ? "font-medium text-ink" : "text-muted"}`}
                title="Hide rarity, rating, and camera info — just the photos"
              >
                {galleryView ? "Gallery view ✓" : "Gallery view"}
              </button>
              {rawOnlyCount > 0 && (
                <div className="flex items-center gap-1 rounded-md border border-line p-0.5 text-xs">
                  {(["all", "edited", "raw"] as const).map((option) => (
                    <button
                      key={option}
                      onClick={() => setPhotoFilter(option)}
                      className={`rounded px-2 py-0.5 ${
                        photoFilter === option ? "bg-ink text-canvas" : "text-muted hover:bg-surface-muted"
                      }`}
                    >
                      {option === "all" ? `All (${editedCount + rawOnlyCount})` : option === "edited" ? `Edited (${editedCount})` : `RAW (${rawOnlyCount})`}
                    </button>
                  ))}
                </div>
              )}
              {captures.length > 0 &&
                (selectMode ? (
                  <button onClick={exitSelectMode} className="text-xs text-muted hover:underline">
                    Cancel
                  </button>
                ) : (
                  <button onClick={() => setSelectMode(true)} className="text-xs text-muted hover:underline">
                    Select
                  </button>
                ))}
              <button
                onClick={() => setShowUploadDialog(true)}
                className="rounded-md bg-accent px-3 py-1 text-xs text-accent-fg hover:opacity-90"
              >
                Upload
              </button>
            </div>
          </div>
          {selectMode && (
            <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-line bg-surface-muted px-3 py-2 text-xs">
              <span className="shrink-0 text-muted">{selectedCaptureIds.size} selected</span>
              {selectedCaptureIds.size > 0 && (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="shrink-0 text-muted">Correct ID to:</span>
                  <div className="w-56">
                    <SpeciesPicker placeholder="Type a species…" onSelect={(s) => reassignSelected(s.id)} />
                  </div>
                  {batchReassigning && <span className="shrink-0 text-muted">Reassigning…</span>}
                </div>
              )}
              <button
                onClick={() => setConfirmingDelete(true)}
                disabled={selectedCaptureIds.size === 0}
                className="shrink-0 rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                Delete selected
              </button>
            </div>
          )}
          {reassignError && <p className="mb-2 text-xs text-red-600">{reassignError}</p>}
          {confirmingDelete && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmingDelete(false)}>
              <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-sm font-medium text-ink">
                  Delete {selectedCaptureIds.size} photo{selectedCaptureIds.size === 1 ? "" : "s"}?
                </h3>
                <p className="mt-2 text-xs text-muted">
                  Deleted photos go to Trash for 7 days first, where you can still restore them. After 7 days they're
                  gone for good and can't be recovered.
                </p>
                {selectedHaveRaw && (
                  <label className="mt-3 flex items-center gap-2 text-xs text-ink">
                    <input type="checkbox" checked={deleteRawToo} onChange={(e) => setDeleteRawToo(e.target.checked)} className="h-3.5 w-3.5" />
                    Also delete the matching RAW file when this is permanently removed
                  </label>
                )}
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    onClick={() => {
                      setConfirmingDelete(false);
                      setDeleteRawToo(false);
                    }}
                    className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-muted"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmDeleteSelected}
                    disabled={deleting}
                    className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
                  >
                    {deleting ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </div>
            </div>
          )}
          {captures.length === 0 && pendingUploadCount === 0 ? (
            <p className="text-sm text-muted">Not photographed yet.</p>
          ) : (
            // No gap at all, in either direction; see MasonryGrid's own comment for why
            // this is a manually
            // computed masonry rather than CSS `column-width`. `i` here is each capture's
            // index in the ORIGINAL (unfiltered) captures array, preserved from before this
            // refactor — captureSlides/the lightbox index expects that, not a position
            // within just the photo-having subset.
            <MasonryGrid
              items={[
                ...captures
                  .map((c, i) => ({ kind: "capture" as const, c, i }))
                  .filter((it) => it.c.photo_id)
                  .filter((it) => photoFilter === "all" || (photoFilter === "raw" ? it.c.original_kind === "raw" : it.c.original_kind !== "raw")),
                // A fake tile per photo currently uploading for this species — shown in the
                // actual photo grid (where the real thing will land) instead of only in the
                // global corner banner, so it's obvious right where the new photo is going.
                ...Array.from({ length: pendingUploadCount }, (_, idx) => ({ kind: "placeholder" as const, key: `pending-${idx}` })),
              ]}
              columnWidth={thumbSizePx}
              keyFor={(item) => (item.kind === "placeholder" ? item.key : item.c.id)}
              aspectRatioFor={(item) =>
                item.kind === "capture" && item.c.width && item.c.height ? item.c.width / item.c.height : null
              }
              renderItem={(item) => {
                if (item.kind === "placeholder") {
                  return (
                    <div
                      key={item.key}
                      className="flex aspect-square w-full items-center justify-center rounded-md bg-surface-muted"
                    >
                      <span className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-ink" />
                    </div>
                  );
                }
                const { c, i } = item;
                return (
                  <div
                    key={c.id}
                    className="group relative min-w-0"
                  >
                    <ProgressiveImg
                      thumbSrc={`/api/photos/${c.photo_id}/thumb`}
                      fullSrc={`/api/photos/${c.photo_id}/display`}
                      alt=""
                      onClick={() => (selectMode ? toggleSelected(c.id) : setLightbox({ slides: captureSlides, index: i }))}
                      className={`block w-full cursor-pointer rounded-md ${
                        selectMode && selectedCaptureIds.has(c.id) ? "ring-2 ring-accent ring-offset-2" : ""
                      }`}
                    />
                    {selectMode && (
                      <input
                        type="checkbox"
                        checked={selectedCaptureIds.has(c.id)}
                        onChange={() => toggleSelected(c.id)}
                        className="absolute left-2 top-2 h-4 w-4 accent-accent"
                        aria-label="Select photo"
                      />
                    )}
                    {!selectMode && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuCaptureId(openMenuCaptureId === c.id ? null : c.id);
                      }}
                      className="absolute right-1 top-1 rounded-full bg-black/40 px-1.5 text-xs text-white opacity-0 group-hover:opacity-100"
                      aria-label="Photo options"
                    >
                      ⋯
                    </button>
                    )}
                    {!selectMode && openMenuCaptureId === c.id && (
                      <div
                        ref={openMenuRef}
                        className="absolute right-1 top-7 z-10 whitespace-nowrap rounded-md border border-line bg-surface py-1 text-xs shadow-lg"
                      >
                        <button
                          onClick={() => setCover(c.photo_id!)}
                          className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                        >
                          {detail.userSpecies?.cover_photo_id === c.photo_id ? "Featured photo ✓" : "Set as featured photo"}
                        </button>
                        {c.original_ref && c.original_available === false ? (
                          <p className="w-full px-3 py-1.5 text-left text-muted">
                            {c.original_volume_label
                              ? `Connect "${c.original_volume_label}" to view this original`
                              : "Original unavailable"}
                          </p>
                        ) : (
                          c.original_ref && (
                            <>
                              <a
                                href={`/api/photos/${c.photo_id}/original?download=1`}
                                className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                              >
                                Download original
                              </a>
                              {c.has_raw_original && (
                                <a
                                  href={`/api/photos/${c.photo_id}/original-raw?download=1`}
                                  className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                                >
                                  Download RAW
                                </a>
                              )}
                              {!c.original_managed && (
                                <>
                                  <button
                                    onClick={() => revealInFinder(c.original_ref!)}
                                    className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                                  >
                                    Reveal in Finder
                                  </button>
                                  <button
                                    onClick={() => {
                                      navigator.clipboard.writeText(c.original_ref!);
                                      setOpenMenuCaptureId(null);
                                    }}
                                    className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                                  >
                                    Copy original's path
                                  </button>
                                </>
                              )}
                            </>
                          )
                        )}
                        {taggingCaptureId === c.id ? (
                          <div className="px-3 py-1.5">
                            <SpeciesPicker
                              autoFocus
                              placeholder="Also features…"
                              onSelect={(s) => tagSpecies(c.id, s.id)}
                            />
                          </div>
                        ) : (
                          <button
                            onClick={() => setTaggingCaptureId(c.id)}
                            className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                          >
                            Also features another species…
                          </button>
                        )}
                        {reassigningCaptureId === c.id ? (
                          <div className="px-3 py-1.5">
                            <SpeciesPicker
                              autoFocus
                              placeholder="Correct ID to…"
                              onSelect={(s) => reassignSpecies(c.id, s.id)}
                            />
                          </div>
                        ) : (
                          <button
                            onClick={() => setReassigningCaptureId(c.id)}
                            className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                          >
                            Correct the ID…
                          </button>
                        )}
                        <button
                          onClick={() => requestDeleteCapture(c.id)}
                          className="block w-full border-t border-line px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                        >
                          Delete Photo
                        </button>
                      </div>
                    )}
                    {!galleryView && detail.userSpecies?.best_quality != null && c.quality_rating === detail.userSpecies.best_quality && (
                      <span className="absolute left-1 top-1 rounded-full bg-black/40 px-1.5 py-0.5 text-[9px] text-white">
                        Best shot
                      </span>
                    )}
                    {/* A small status dot, not a full text label — the actual explanation
                       (and, when it's a disconnected drive, which one) lives in the ⋯ menu
                       above rather than crowding the thumbnail itself. */}
                    {c.original_available === false && (
                      <span
                        className="absolute left-1.5 bottom-1.5 h-2.5 w-2.5 rounded-full bg-red-600 shadow"
                        title={
                          c.original_volume_label
                            ? `Original unavailable — connect "${c.original_volume_label}" to view it`
                            : "Original unavailable — the file couldn't be found at its saved location"
                        }
                      />
                    )}
                    {!galleryView && (
                      <div className="mt-1">
                        <StarRating rating={c.quality_rating} onRate={(rating) => rateCapture(c.id, rating)} />
                      </div>
                    )}
                    {!galleryView && c.taken_at && (
                      <p className="mt-0.5 text-[10px] text-muted">{new Date(c.taken_at).toLocaleDateString()}</p>
                    )}
                    {!galleryView && shotDataLine(c) && <p className="text-[9px] text-muted">{shotDataLine(c)}</p>}
                  </div>
                );
              }}
            />
          )}
        </section>

        {/* RAWs filed straight into this species' folder with no matching JPEG (see
           RawUpload). Same "⋯" menu pattern as the photo grid above; a real RAW can't be
           decoded in-browser, so there's nothing here for a click-to-preview lightbox to
           usefully show beyond the small embedded-preview thumbnail already visible, and
           there's no capture here to hang a star rating or "set as featured" on either, so
           Download is the one real action. */}
        {unmatchedRaws.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-medium text-ink">RAW gallery</h2>
            <div className="flex flex-wrap gap-3">
              {unmatchedRaws.map((r) => (
                <div key={r.id} className="group relative w-32 rounded-md border border-line bg-surface p-2 text-center">
                  <img src={r.previewUrl} alt="" className="aspect-square w-full rounded-sm bg-surface-muted object-cover" />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenRawMenuId(openRawMenuId === r.id ? null : r.id);
                    }}
                    className="absolute right-1 top-1 rounded-full bg-black/40 px-1.5 text-xs text-white opacity-0 group-hover:opacity-100"
                    aria-label="RAW file options"
                  >
                    ⋯
                  </button>
                  {openRawMenuId === r.id && (
                    <div
                      ref={openRawMenuRef}
                      className="absolute right-1 top-7 z-10 whitespace-nowrap rounded-md border border-line bg-surface py-1 text-xs shadow-lg"
                    >
                      <a
                        href={r.downloadUrl}
                        className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                      >
                        Download
                      </a>
                    </div>
                  )}
                  <p className="mt-1 truncate text-[10px] text-muted">{r.filename}</p>
                  <p className="text-[9px] text-muted">{(r.fileSize / (1024 * 1024)).toFixed(1)} MB</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Upload forms are tucked behind a single "Upload" button (see the "Your photos"
         header above) instead of being permanently visible and taking
         up space at the bottom of every species page. Same backdrop-click-to-close pattern
         as CardCropEditor. */}
      {showUploadDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShowUploadDialog(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-lg bg-surface-muted p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-ink">Upload</h2>
              <button
                onClick={() => setShowUploadDialog(false)}
                className="text-muted hover:text-muted"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <VolumeDestinationPicker {...volumeDestination} />
            <UploadDropzone
              speciesId={species.id}
              volumeId={volumeDestination.volumeId}
              onUploaded={load}
              onClose={() => setShowUploadDialog(false)}
            />
            <RawUpload speciesId={species.id} volumeId={volumeDestination.volumeId} onFiled={loadUnmatchedRaws} />
          </div>
        </div>
      )}

      {lightbox && (
        <Lightbox
          slides={lightbox.slides}
          index={lightbox.index}
          onIndexChange={(index) => setLightbox({ slides: lightbox.slides, index })}
          onClose={() => setLightbox(null)}
        />
      )}

      {croppingCover && detail.userSpecies?.cover_photo_id && (
        <CardCropEditor
          photoUrl={`/api/photos/${detail.userSpecies.cover_photo_id}/display`}
          initialX={detail.userSpecies.card_crop_x == null ? null : Number(detail.userSpecies.card_crop_x)}
          initialY={detail.userSpecies.card_crop_y == null ? null : Number(detail.userSpecies.card_crop_y)}
          initialSize={detail.userSpecies.card_crop_size == null ? null : Number(detail.userSpecies.card_crop_size)}
          onClose={() => setCroppingCover(false)}
          onSave={async (crop) => {
            await api.patch(`/species/${id}/card-crop`, crop);
            load();
          }}
          onReset={async () => {
            await api.patch(`/species/${id}/card-crop`, { reset: true });
            load();
          }}
        />
      )}
    </div>
  );
}

// mass_g is stored in grams for every taxon (a consistent sortable/comparable unit) — but
// showing a Blue Whale's mass as "136000000 g" is unreadable, so display picks the tier a
// person would actually use (g / kg / t) rather than converting the stored unit itself.
function formatMass(massG: number): string {
  if (massG >= 1_000_000) return `${(massG / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} t`;
  if (massG >= 1_000) return `${(massG / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
  return `${Math.round(massG)} g`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}
