import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import BackToCollectionLink from "../components/BackToCollectionLink";
import MasonryGrid from "../components/MasonryGrid";
import ProgressiveImg from "../components/ProgressiveImg";
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
import { shotDataLine } from "../lib/shotData";

interface GalleryItem {
  photoId: string;
  speciesId: string;
  scientificName: string;
  commonName: string | null;
  takenAt: string | null;
  cameraModel: string | null;
  lens: string | null;
  focalLengthMm: number | null;
  aperture: number | null;
  shutter: string | null;
  iso: number | null;
}

// Every photo taken, across all species, as one browsable gallery — separate from the
// per-species detail view. Uses the same MasonryGrid (natural aspect ratio, no forced
// square, uneven column endings are fine), the same size slider (the same localStorage key
// as SpeciesDetailPage's own-photo grid — see usePhotoGridSize), and the same thumb->display
// progressive upgrade instead of settling for a permanently low-res thumbnail. There's no
// info toggle inside the lightbox here; instead a "Camera info" toggle on the grid itself
// shows the same shotDataLine caption under each thumbnail that SpeciesDetailPage uses.
export default function GalleryPage() {
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  const [showCameraInfo, setShowCameraInfo] = useState(false);

  useEffect(() => {
    api.get<{ items: GalleryItem[] }>("/gallery").then((res) => setItems(res.items));
  }, []);

  const slides = useMemo<LightboxSlide[]>(
    () =>
      (items ?? []).map((i) => ({
        url: `/api/photos/${i.photoId}/display`,
        caption: `${i.commonName ?? i.scientificName}${i.takenAt ? " · " + new Date(i.takenAt).toLocaleDateString() : ""}`,
      })),
    [items],
  );

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Top-left, above the title, same as every other page's header. */}
      <header className="flex items-center justify-between border-b border-stone-200 bg-white px-6 py-4">
        <div>
          <BackToCollectionLink className="text-sm text-stone-500 hover:underline" />
          <h1 className="mt-1 text-lg font-semibold text-stone-900">Gallery</h1>
          {items && <p className="text-xs text-stone-500">{items.length} photos</p>}
        </div>
        {items && items.length > 0 && (
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-xs text-stone-400">
              <input
                type="checkbox"
                checked={showCameraInfo}
                onChange={(e) => setShowCameraInfo(e.target.checked)}
                className="accent-stone-700"
              />
              Camera info
            </label>
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
          </div>
        )}
      </header>

      <main className="p-6">
        {!items ? (
          <p className="text-stone-500">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-stone-500">No photos yet — upload one from a species page to get started.</p>
        ) : (
          <MasonryGrid
            items={items.map((item, i) => ({ item, i }))}
            columnWidth={thumbSizePx}
            keyFor={({ item }) => item.photoId}
            renderItem={({ item, i }) => (
              <button key={item.photoId} onClick={() => setLightboxIndex(i)} className="block w-full text-left">
                <ProgressiveImg
                  thumbSrc={`/api/photos/${item.photoId}/thumb`}
                  fullSrc={`/api/photos/${item.photoId}/display`}
                  alt={item.commonName ?? item.scientificName}
                  className="block w-full cursor-pointer rounded-md"
                />
                <p className="mt-1 truncate text-[11px] text-stone-500">{item.commonName ?? item.scientificName}</p>
                {showCameraInfo && shotDataLine({
                  camera_model: item.cameraModel,
                  lens: item.lens,
                  focal_length_mm: item.focalLengthMm,
                  aperture: item.aperture,
                  shutter: item.shutter,
                  iso: item.iso,
                }) && (
                  <p className="truncate text-[9px] text-stone-400">
                    {shotDataLine({
                      camera_model: item.cameraModel,
                      lens: item.lens,
                      focal_length_mm: item.focalLengthMm,
                      aperture: item.aperture,
                      shutter: item.shutter,
                      iso: item.iso,
                    })}
                  </p>
                )}
              </button>
            )}
          />
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox slides={slides} index={lightboxIndex} onIndexChange={setLightboxIndex} onClose={() => setLightboxIndex(null)} />
      )}
    </div>
  );
}
