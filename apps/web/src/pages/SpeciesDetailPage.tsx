import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import UploadDropzone from "../components/UploadDropzone";
import RawUpload from "../components/RawUpload";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import CardCropEditor from "../components/CardCropEditor";
import SeasonalityBar from "../components/SeasonalityBar";
import SpeciesPicker from "../components/SpeciesPicker";
import ProgressiveImg from "../components/ProgressiveImg";
import BackToCollectionLink from "../components/BackToCollectionLink";
import MasonryGrid from "../components/MasonryGrid";
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
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
    description: string | null;
    description_credit: string | null;
    description_source_url: string | null;
    habitat_description: string | null;
  };
  captures: Array<{
    id: string;
    photo_id: string | null;
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
  referencePhotos: Array<{ photo_url: string; credit: string; license: string }>;
  seasonality: number[] | null;
  localTier: string | null;
  isVagrant: boolean;
  endemicCountryName: string | null;
}

// "Show me this photo big" prefers the full-resolution original when one exists (store or
// link mode — see the originals feature); falls back to the 2560px display WebP for
// captures predating it. RAW originals (Phase 7, not yet possible) would need to keep using
// /display instead, since browsers can't render RAW.

function fullSizeUrl(capture: { photo_id: string | null; original_ref: string | null; original_kind: string | null }) {
  if (!capture.photo_id) return null;
  if (capture.original_ref && capture.original_kind === "jpeg") {
    return `/api/photos/${capture.photo_id}/original`;
  }
  return `/api/photos/${capture.photo_id}/display`;
}


export default function SpeciesDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const regionId = searchParams.get("regionId");
  const [detail, setDetail] = useState<SpeciesDetail | null>(null);
  const [lightbox, setLightbox] = useState<{ slides: LightboxSlide[]; index: number } | null>(null);
  const [openMenuCaptureId, setOpenMenuCaptureId] = useState<string | null>(null);
  const [taggingCaptureId, setTaggingCaptureId] = useState<string | null>(null);
  const [croppingCover, setCroppingCover] = useState(false);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Target thumbnail width in px, fed to MasonryGrid instead of fixed Tailwind breakpoint
  // column counts, so it's a true continuous size control rather than a handful of discrete
  // column-count steps. Shared with GalleryPage via the same localStorage key (see
  // usePhotoGridSize's own comment) so both pages stay in sync.
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();

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
      slides.push({ url: species.reference_photo_url, caption: species.reference_credit });
    }

    for (const p of referencePhotos) {
      if (p.photo_url === species.reference_photo_url && !userSpecies?.cover_photo_id) continue;
      slides.push({ url: p.photo_url, caption: p.credit });
    }
    return slides;
  }, [detail]);

  const [heroIndex, setHeroIndex] = useState(0);
  useEffect(() => setHeroIndex(0), [heroSlides.length]);

  if (loadError) {
    return (
      <div className="p-8 text-stone-500">
        Couldn't load this species.{" "}
        <button onClick={load} className="text-stone-900 underline">
          Retry
        </button>
      </div>
    );
  }
  if (!detail) return <div className="p-8 text-stone-500">Loading…</div>;
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

  async function revealInFinder(path: string) {
    setOpenMenuCaptureId(null);
    await api.post("/originals/reveal", { path }).catch(() => alert("Couldn't reveal that file — it may be unavailable."));
  }

  async function rateCapture(captureId: string, rating: number | null) {
    await api.patch(`/captures/${captureId}/rating`, { rating });
    load();
  }

  async function removeCapture(captureId: string) {
    setOpenMenuCaptureId(null);
    if (!confirm("Remove this photo from Lifer? The original file (if you have one) won't be touched.")) return;
    await api.delete(`/captures/${captureId}`);
    load();
  }

  // Marks a photo as also containing another species (e.g. a hawk catching a fish) — the
  // tagged species counts as fully collected too, and this same photo then shows up on its
  // detail page as well (see species/routes.ts's captures query, which also matches via
  // capture_species).
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
    <div className="min-h-screen bg-stone-50">
      <header className="border-b border-stone-200 bg-white px-6 py-4">
        <BackToCollectionLink
          fallbackTo={regionId ? `/?region=${regionId}` : "/"}
          className="text-sm text-stone-500 hover:underline"
        />
      </header>

      {/* <main> itself is full width (the photo grid below spreads out across it, keeping
         the masonry/progressive-loading layout), while the reference photo and species info
         sit in their own centered narrow column rather than sharing in that width. */}
      <main className="w-full space-y-6 p-6">
        {/* 48rem (3xl) * 1.3 ≈ 62.4rem. */}
        <div className="mx-auto max-w-[62.4rem] space-y-6">
        {heroSlides.length === 0 ? (
          <div className="flex aspect-[16/9] items-center justify-center rounded-lg bg-stone-100 text-stone-300">
            ?
          </div>
        ) : (
          // Fills this wrapper's own width, same as the description text below it, rather
          // than being capped to a separate width.
          <figure className="relative">
            <img
              src={heroSlides[heroIndex].url}
              alt={species.common_name ?? species.scientific_name}
              onClick={() => setLightbox({ slides: heroSlides, index: heroIndex })}
              className="aspect-[16/9] w-full cursor-pointer rounded-lg object-cover"
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
                <span className="absolute bottom-2 right-2 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white">
                  {heroIndex + 1} / {heroSlides.length}
                </span>
              </>
            )}
            {heroSlides[heroIndex].caption && (
              <figcaption className="mt-1 text-[11px] text-stone-400">{heroSlides[heroIndex].caption}</figcaption>
            )}
          </figure>
        )}

        <div>
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-stone-900">{species.common_name ?? species.scientific_name}</h1>
              <p className="italic text-stone-500">{species.scientific_name}</p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {detail.userSpecies?.cover_photo_id && (
                <button onClick={() => setCroppingCover(true)} className="text-xs text-stone-400 hover:underline">
                  Adjust card preview
                </button>
              )}
              {detail.userSpecies?.state === "seen" ? (
                <button onClick={unmarkSeen} className="text-xs text-stone-400 hover:underline">
                  ✓ Seen (undo)
                </button>
              ) : !detail.userSpecies ? (
                <button onClick={markSeen} className="text-xs text-stone-400 hover:underline">
                  Mark as seen
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
                      ? "inline-block rounded-full border border-dashed border-stone-300 px-2 py-0.5 text-xs uppercase tracking-wide text-stone-400"
                      : "inline-block rounded-full bg-stone-100 px-2 py-0.5 text-xs uppercase tracking-wide text-stone-600"
                  }
                  title={species.tier === "unrated" ? "Not enough data yet to rate how hard this is to find" : undefined}
                >
                  {species.tier === "unrated" ? "Unrated" : species.tier}
                </span>
              )}
              {detail.localTier && (
                <span
                  className="inline-block rounded-full border border-stone-300 px-2 py-0.5 text-xs uppercase tracking-wide text-stone-500"
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
          <p className="text-sm text-stone-700">
            {species.description}{" "}
            {species.description_source_url && (
              <a href={species.description_source_url} target="_blank" rel="noreferrer" className="text-stone-400 hover:underline">
                (Wikipedia)
              </a>
            )}
          </p>
        )}
        {species.habitat_description && (
          <p className="text-sm text-stone-700">
            <span className="font-medium text-stone-500">Habitat: </span>
            {species.habitat_description}
          </p>
        )}

        {/* Per-taxon stats — wingspan/niche only ever had real data for
           birds (AVONET/EltonTraits), so showing them for mammals/fish was always just a
           blank "—" that implied a bird-shaped trait set applies to every taxon. Each taxon
           shows only the axes it actually has a real source for. */}
        <dl className="grid grid-cols-2 gap-2 rounded-lg border border-stone-200 bg-white p-4 text-sm sm:grid-cols-4">
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
              className="text-stone-500 hover:underline"
            >
              View on iNaturalist ↗
            </a>
          )}
          {species.ebird_code && (
            <a
              href={`https://ebird.org/species/${species.ebird_code}`}
              target="_blank"
              rel="noreferrer"
              className="text-stone-500 hover:underline"
            >
              View on eBird ↗
            </a>
          )}
        </div>
        </div>

        <section>
          <div className="mb-2 flex items-center justify-between gap-4">
            <h2 className="text-sm font-medium text-stone-700">Your photos</h2>
            <div className="flex items-center gap-4">
              {captures.length > 0 && (
                <label className="flex items-center gap-1.5 text-xs text-stone-400">
                  Size
                  <input
                    type="range"
                    min={120}
                    max={800}
                    step={20}
                    value={thumbSizePx}
                    onChange={(e) => updateThumbSize(Number(e.target.value))}
                    className="w-24 accent-stone-700"
                    aria-label="Photo grid thumbnail size"
                  />
                </label>
              )}
              <button
                onClick={toggleGalleryView}
                className={`text-xs hover:underline ${galleryView ? "font-medium text-stone-700" : "text-stone-400"}`}
                title="Hide rarity, rating, and camera info — just the photos"
              >
                {galleryView ? "Gallery view ✓" : "Gallery view"}
              </button>
              <button
                onClick={() => setShowUploadDialog(true)}
                className="rounded-md bg-stone-800 px-3 py-1 text-xs text-white hover:bg-stone-700"
              >
                Upload
              </button>
            </div>
          </div>
          {captures.length === 0 ? (
            <p className="text-sm text-stone-500">Not photographed yet.</p>
          ) : (
            // No gap at all, in either direction; see MasonryGrid's own comment for why
            // this is a manually
            // computed masonry rather than CSS `column-width`. `i` here is each capture's
            // index in the ORIGINAL (unfiltered) captures array, preserved from before this
            // refactor — captureSlides/the lightbox index expects that, not a position
            // within just the photo-having subset.
            <MasonryGrid
              items={captures.map((c, i) => ({ c, i })).filter(({ c }) => c.photo_id)}
              columnWidth={thumbSizePx}
              keyFor={({ c }) => c.id}
              renderItem={({ c, i }) => (
                  <div
                    key={c.id}
                    className="group relative"
                  >
                    <ProgressiveImg
                      thumbSrc={`/api/photos/${c.photo_id}/thumb`}
                      fullSrc={`/api/photos/${c.photo_id}/display`}
                      alt=""
                      onClick={() => setLightbox({ slides: captureSlides, index: i })}
                      className="block w-full cursor-pointer rounded-md"
                    />
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
                    {openMenuCaptureId === c.id && (
                      <div
                        ref={openMenuRef}
                        className="absolute right-1 top-7 z-10 whitespace-nowrap rounded-md border border-stone-200 bg-white py-1 text-xs shadow-lg"
                      >
                        <button
                          onClick={() => setCover(c.photo_id!)}
                          className="block w-full px-3 py-1.5 text-left text-stone-700 hover:bg-stone-50"
                        >
                          {detail.userSpecies?.cover_photo_id === c.photo_id ? "Featured photo ✓" : "Set as featured photo"}
                        </button>
                        {c.original_ref && c.original_available === false ? (
                          <p className="w-full px-3 py-1.5 text-left text-stone-400">Original unavailable</p>
                        ) : (
                          c.original_ref && (
                            <>
                              <a
                                href={`/api/photos/${c.photo_id}/original?download=1`}
                                className="block w-full px-3 py-1.5 text-left text-stone-700 hover:bg-stone-50"
                              >
                                Download original
                              </a>
                              {c.has_raw_original && (
                                <a
                                  href={`/api/photos/${c.photo_id}/original-raw?download=1`}
                                  className="block w-full px-3 py-1.5 text-left text-stone-700 hover:bg-stone-50"
                                >
                                  Download RAW
                                </a>
                              )}
                              {!c.original_managed && (
                                <>
                                  <button
                                    onClick={() => revealInFinder(c.original_ref!)}
                                    className="block w-full px-3 py-1.5 text-left text-stone-700 hover:bg-stone-50"
                                  >
                                    Reveal in Finder
                                  </button>
                                  <button
                                    onClick={() => {
                                      navigator.clipboard.writeText(c.original_ref!);
                                      setOpenMenuCaptureId(null);
                                    }}
                                    className="block w-full px-3 py-1.5 text-left text-stone-700 hover:bg-stone-50"
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
                            className="block w-full px-3 py-1.5 text-left text-stone-700 hover:bg-stone-50"
                          >
                            Also features another species…
                          </button>
                        )}
                        <button
                          onClick={() => removeCapture(c.id)}
                          className="block w-full border-t border-stone-100 px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                        >
                          Remove from Lifer
                        </button>
                      </div>
                    )}
                    {!galleryView && detail.userSpecies?.best_quality != null && c.quality_rating === detail.userSpecies.best_quality && (
                      <span className="absolute left-1 top-1 rounded-full bg-black/40 px-1.5 py-0.5 text-[9px] text-white">
                        Best shot
                      </span>
                    )}
                    {c.original_available === false && (
                      <span
                        className="absolute left-1 bottom-1 rounded-full bg-red-900/70 px-1.5 py-0.5 text-[9px] text-white"
                        title="The original file couldn't be found at its saved location"
                      >
                        Original unavailable
                      </span>
                    )}
                    {!galleryView && (
                      <div className="mt-1 flex gap-0.5">
                        {[1, 2, 3, 4, 5].map((star) => (
                          <button
                            key={star}
                            onClick={() => rateCapture(c.id, c.quality_rating === star ? null : star)}
                            className={`text-xs leading-none ${
                              c.quality_rating != null && star <= c.quality_rating ? "text-amber-500" : "text-stone-300"
                            }`}
                            aria-label={`Rate ${star} star${star === 1 ? "" : "s"}`}
                          >
                            ★
                          </button>
                        ))}
                      </div>
                    )}
                    {!galleryView && c.taken_at && (
                      <p className="mt-0.5 text-[10px] text-stone-400">{new Date(c.taken_at).toLocaleDateString()}</p>
                    )}
                    {!galleryView && shotDataLine(c) && <p className="text-[9px] text-stone-400">{shotDataLine(c)}</p>}
                  </div>
              )}
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
            <h2 className="mb-2 text-sm font-medium text-stone-700">RAW gallery</h2>
            <div className="flex flex-wrap gap-3">
              {unmatchedRaws.map((r) => (
                <div key={r.id} className="group relative w-32 rounded-md border border-stone-200 bg-white p-2 text-center">
                  <img src={r.previewUrl} alt="" className="aspect-square w-full rounded-sm bg-stone-100 object-cover" />
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
                      className="absolute right-1 top-7 z-10 whitespace-nowrap rounded-md border border-stone-200 bg-white py-1 text-xs shadow-lg"
                    >
                      <a
                        href={r.downloadUrl}
                        className="block w-full px-3 py-1.5 text-left text-stone-700 hover:bg-stone-50"
                      >
                        Download
                      </a>
                    </div>
                  )}
                  <p className="mt-1 truncate text-[10px] text-stone-600">{r.filename}</p>
                  <p className="text-[9px] text-stone-400">{(r.fileSize / (1024 * 1024)).toFixed(1)} MB</p>
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
            className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-lg bg-stone-50 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-stone-700">Upload</h2>
              <button
                onClick={() => setShowUploadDialog(false)}
                className="text-stone-400 hover:text-stone-600"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <UploadDropzone speciesId={species.id} onUploaded={load} />
            <RawUpload speciesId={species.id} onFiled={loadUnmatchedRaws} />
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
          speciesId={species.id}
          photoUrl={`/api/photos/${detail.userSpecies.cover_photo_id}/display`}
          initialX={detail.userSpecies.card_crop_x == null ? null : Number(detail.userSpecies.card_crop_x)}
          initialY={detail.userSpecies.card_crop_y == null ? null : Number(detail.userSpecies.card_crop_y)}
          initialSize={detail.userSpecies.card_crop_size == null ? null : Number(detail.userSpecies.card_crop_size)}
          onClose={() => setCroppingCover(false)}
          onSaved={load}
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
      <dt className="text-[10px] uppercase tracking-wide text-stone-400">{label}</dt>
      <dd className="text-stone-800">{value}</dd>
    </div>
  );
}
