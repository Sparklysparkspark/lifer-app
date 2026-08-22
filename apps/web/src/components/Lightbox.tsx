import { useEffect, useState } from "react";

export interface LightboxSlide {
  url: string;
  caption?: string | null;
  // Structured rather than a single preformatted string, so the detail view (see showInfo
  // below) can lay each field out as its own labeled row instead of one run-on line.
  info?: {
    cameraModel?: string | null;
    lens?: string | null;
    focalLengthMm?: number | string | null;
    aperture?: number | string | null;
    shutter?: string | null;
    iso?: number | null;
    takenAt?: string | null;
  } | null;
}

function InfoRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value == null || value === "") return null;
  return (
    <div className="flex justify-between gap-4 border-b border-stone-100 py-1.5 text-sm last:border-0">
      <span className="text-stone-400">{label}</span>
      <span className="text-stone-800">{value}</span>
    </div>
  );
}

// Full-size image viewer (Immich-style click-to-view), with left/right navigation and
// Escape/backdrop-click to close. An "ⓘ" toggle switches from the default immersive dark
// viewer to a white, scrollable detail layout: image on top, camera info laid out below it
// as labeled rows, rather than overlaid captions on a dark backdrop.
export default function Lightbox({
  slides,
  index,
  onIndexChange,
  onClose,
}: {
  slides: LightboxSlide[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const [showInfo, setShowInfo] = useState(false);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onIndexChange((index + 1) % slides.length);
      else if (e.key === "ArrowLeft") onIndexChange((index - 1 + slides.length) % slides.length);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [index, slides.length, onIndexChange, onClose]);

  const slide = slides[index];
  if (!slide) return null;

  const hasInfo = !!(slide.info && Object.values(slide.info).some((v) => v != null && v !== ""));
  const buttonClass = showInfo
    ? "rounded-full bg-stone-100 p-3 text-xl text-stone-500 hover:bg-stone-200"
    : "rounded-full bg-black/40 p-3 text-xl text-white hover:bg-black/60";

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center overflow-y-auto p-4 ${
        showInfo ? "justify-start bg-white" : "justify-center bg-black/90"
      }`}
      onClick={onClose}
    >
      <div className={`flex w-full items-center justify-end gap-2 ${showInfo ? "" : "absolute right-4 top-4"}`}>
        {hasInfo && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowInfo((v) => !v);
            }}
            className={showInfo ? "rounded-full bg-stone-100 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-200" : "text-2xl text-white/70 hover:text-white"}
            aria-label="Toggle photo info"
            aria-pressed={showInfo}
          >
            {showInfo ? "Done" : "ⓘ"}
          </button>
        )}
        <button
          onClick={onClose}
          className={showInfo ? "text-2xl text-stone-400 hover:text-stone-700" : "text-2xl text-white/70 hover:text-white"}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {!showInfo && slides.length > 1 && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange((index - 1 + slides.length) % slides.length);
            }}
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-3 text-xl text-white hover:bg-black/60 sm:left-6"
            aria-label="Previous"
          >
            ‹
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange((index + 1) % slides.length);
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-3 text-xl text-white hover:bg-black/60 sm:right-6"
            aria-label="Next"
          >
            ›
          </button>
        </>
      )}

      {showInfo ? (
        <div className="mx-auto w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
          <img src={slide.url} alt="" className="mx-auto max-h-[60vh] max-w-full rounded-lg object-contain shadow-sm" />
          <div className="mt-4 rounded-lg border border-stone-200 p-4">
            {slide.caption && <p className="mb-2 text-sm font-medium text-stone-800">{slide.caption}</p>}
            <InfoRow label="Camera" value={slide.info?.cameraModel} />
            <InfoRow label="Lens" value={slide.info?.lens} />
            <InfoRow
              label="Focal length"
              value={slide.info?.focalLengthMm ? `${Math.round(Number(slide.info.focalLengthMm))}mm` : null}
            />
            <InfoRow label="Aperture" value={slide.info?.aperture ? `f/${slide.info.aperture}` : null} />
            <InfoRow label="Shutter" value={slide.info?.shutter} />
            <InfoRow label="ISO" value={slide.info?.iso} />
            <InfoRow
              label="Taken"
              value={slide.info?.takenAt ? new Date(slide.info.takenAt).toLocaleDateString() : null}
            />
          </div>
          {slides.length > 1 && (
            <div className="mt-3 flex items-center justify-center gap-4 text-sm text-stone-400">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onIndexChange((index - 1 + slides.length) % slides.length);
                }}
                className="hover:text-stone-700"
              >
                ‹ Previous
              </button>
              <span>
                {index + 1} / {slides.length}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onIndexChange((index + 1) % slides.length);
                }}
                className="hover:text-stone-700"
              >
                Next ›
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <img
            src={slide.url}
            alt=""
            className="max-h-[85vh] max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          {(slide.caption || slides.length > 1) && (
            <div className="mt-3 text-center text-sm text-white/70" onClick={(e) => e.stopPropagation()}>
              {slide.caption}
              {slides.length > 1 && <span className="ml-2 text-white/40">{index + 1} / {slides.length}</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
