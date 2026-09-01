import { useEffect, useRef, useState } from "react";
import PhotoPlaceholder from "./PhotoPlaceholder";

export interface LightboxSlide {
  url: string;
  caption?: string | null;
  // Only meaningful to callers that show this slide inside an object-cover box (e.g. the
  // species detail page's 16:9 hero) — Lightbox itself always shows the full photo
  // (object-contain), so it never reads these, just carries them through per slide.
  focalX?: number | null;
  focalY?: number | null;
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
    <div className="flex justify-between gap-4 border-b border-line py-1.5 text-sm last:border-0">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 break-words text-right text-ink">{value}</span>
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
  // Scroll-wheel/trackpad-pinch zoom (macOS/WKWebView reports a trackpad pinch as a wheel
  // event, so this covers both without separate touch-gesture handling) plus drag-to-pan once
  // zoomed in. Reset whenever the slide changes or the info panel toggles — panning/zoom state
  // from one photo has no business carrying over to the next.
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // A slide whose file has moved/been deleted/never existed shouldn't take the whole viewer
  // down with it — falls back to a placeholder for just that one slide, keeping close/arrows
  // fully working so a broken photo is never a dead end you have to reload the page to escape.
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [index]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onIndexChange((index + 1) % slides.length);
      else if (e.key === "ArrowLeft") onIndexChange((index - 1 + slides.length) % slides.length);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [index, slides.length, onIndexChange, onClose]);

  useEffect(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, [index, showInfo]);

  function onWheelZoom(e: React.WheelEvent) {
    e.preventDefault();
    e.stopPropagation();
    setScale((s) => {
      const next = Math.min(4, Math.max(1, s - e.deltaY * 0.01));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }

  function onDoubleClickZoom(e: React.MouseEvent) {
    e.stopPropagation();
    setScale((s) => (s > 1 ? 1 : 2));
    setPan({ x: 0, y: 0 });
  }

  function onDragStart(e: React.MouseEvent) {
    if (scale <= 1) return;
    e.stopPropagation();
    setDragging(true);
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
  }
  function onDragMove(e: React.MouseEvent) {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.panX + (e.clientX - d.startX), y: d.panY + (e.clientY - d.startY) });
  }
  function onDragEnd() {
    dragRef.current = null;
    setDragging(false);
  }

  const slide = slides[index];
  if (!slide) return null;

  const hasInfo = !!(slide.info && Object.values(slide.info).some((v) => v != null && v !== ""));
  const buttonClass = showInfo
    ? "rounded-full bg-surface-muted p-3 text-xl text-muted hover:bg-surface-muted"
    : "rounded-full bg-black/40 p-3 text-xl text-white hover:bg-black/60";

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center overflow-y-auto p-4 ${
        showInfo ? "justify-start bg-canvas" : "justify-center bg-black/90"
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
            className={showInfo ? "rounded-full bg-surface-muted px-3 py-1.5 text-sm text-muted hover:bg-surface-muted" : "text-2xl text-white/70 hover:text-white"}
            aria-label="Toggle photo info"
            aria-pressed={showInfo}
          >
            {showInfo ? "Done" : "ⓘ"}
          </button>
        )}
        <button
          onClick={onClose}
          className={showInfo ? "text-2xl text-muted hover:text-ink" : "text-2xl text-white/70 hover:text-white"}
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
          {imageFailed ? (
            <PhotoPlaceholder className="mx-auto h-64 max-h-[60vh] w-64 max-w-full rounded-lg" />
          ) : (
            <img
              src={slide.url}
              alt=""
              className="mx-auto max-h-[60vh] max-w-full rounded-lg object-contain shadow-sm"
              onError={() => setImageFailed(true)}
            />
          )}
          <div className="mt-4 rounded-lg border border-line p-4">
            {slide.caption && <p className="mb-2 text-sm font-medium text-ink">{slide.caption}</p>}
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
            <div className="mt-3 flex items-center justify-center gap-4 text-sm text-muted">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onIndexChange((index - 1 + slides.length) % slides.length);
                }}
                className="hover:text-ink"
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
                className="hover:text-ink"
              >
                Next ›
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {imageFailed ? (
            <PhotoPlaceholder className="h-64 max-h-[85vh] w-64 max-w-full" onClick={(e) => e.stopPropagation()} />
          ) : (
            <img
              src={slide.url}
              alt=""
              draggable={false}
              className="max-h-[85vh] max-w-full select-none object-contain"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                transition: dragging ? "none" : "transform 0.05s ease-out",
                cursor: scale > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
              }}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={onDoubleClickZoom}
              onWheel={onWheelZoom}
              onMouseDown={onDragStart}
              onMouseMove={onDragMove}
              onMouseUp={onDragEnd}
              onMouseLeave={onDragEnd}
              onError={() => setImageFailed(true)}
            />
          )}
          {!imageFailed && scale > 1 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setScale(1);
                setPan({ x: 0, y: 0 });
              }}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1 text-xs text-white hover:bg-black/60"
            >
              Reset zoom
            </button>
          )}
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
