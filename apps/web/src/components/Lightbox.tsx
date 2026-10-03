import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Link } from "react-router-dom";
import PhotoPlaceholder from "./PhotoPlaceholder";
import { markDragBlocked } from "../lib/modalDragBlock";
import { tauriCurrentWindow } from "../lib/tauri";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { formatDate } from "../lib/formatDate";
import { downloadFile } from "../lib/downloadFile";

export interface LightboxSlide {
  url: string;
  /** Video slides play in a plain <video controls>; zoom and pan are image-only. */
  videoUrl?: string | null;
  /** A RAW file the browser can't decode: shows a badge instead of a broken <img>. */
  noPreview?: boolean;
  caption?: string | null;
  /** 1-5 rating plus setter; lets the 1-5 keys rate the open slide. */
  rating?: number | null;
  onRate?: (rating: number | null) => void;
  // Adds a "View species" link; omitted on the species page itself.
  speciesId?: string | null;
  // Carried through for callers that crop the slide (the species hero); Lightbox ignores them.
  focalX?: number | null;
  focalY?: number | null;
  info?: {
    cameraModel?: string | null;
    lens?: string | null;
    focalLengthMm?: number | string | null;
    aperture?: number | string | null;
    shutter?: string | null;
    iso?: number | null;
    takenAt?: string | null;
    durationSeconds?: number | string | null;
    /** Stored file locations (edited JPEG and any RAW), shown by file name. See photoFilePaths. */
    files?: string[];
  } | null;
  tags?: string[] | null;
  onTagsChange?: (tags: string[]) => void;
  /** When set, shows a download button for this slide. */
  download?: { url: string; filename: string } | null;
}

/** The stored files for a photo, for LightboxSlide.info.files: the main original and its RAW,
 *  without repeats (a RAW-only photo has the same file as both). */
export function photoFilePaths(...refs: Array<string | null | undefined>): string[] {
  return [...new Set(refs.filter((r): r is string => !!r))];
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

function fileNameOf(ref: string): string {
  return ref.split(/[\\/]/).pop() || ref;
}

export function TagEditor({
  tags,
  onChange,
  existingTags,
  label = "Tags",
  compact = false,
  dark = false,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  /** Tags used elsewhere, for autocomplete; omit to disable suggestions. */
  existingTags?: string[];
  label?: string;
  /** Drops the heading and top border, for inline use in a toolbar row. */
  compact?: boolean;
  /** White-on-black styling for Lightbox's fixed black backdrop, which ignores the app theme. */
  dark?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);

  function commitTag(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!tags.includes(trimmed)) onChange([...tags, trimmed]);
    setDraft("");
    setSuggestionsOpen(false);
  }

  const suggestions = (
    draft.trim() && existingTags
      ? existingTags.filter((t) => t.toLowerCase().includes(draft.trim().toLowerCase()) && !tags.includes(t))
      : []
  ).slice(0, 6);

  return (
    <div
      className={compact ? "" : `mt-3 border-t pt-3 ${dark ? "border-white/20" : "border-line"}`}
      onClick={(e) => e.stopPropagation()}
    >
      {!compact && (
        <p className={`mb-2 text-xs font-medium uppercase tracking-wide ${dark ? "text-white/60" : "text-muted"}`}>
          {label}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
              dark ? "border-white/30 bg-white/10 text-white" : "border-line bg-surface-muted text-ink"
            }`}
          >
            {tag}
            <button
              type="button"
              onClick={() => onChange(tags.filter((t) => t !== tag))}
              className={dark ? "text-white/70 hover:text-white" : "text-muted hover:text-ink"}
              aria-label={`Remove tag ${tag}`}
            >
              ×
            </button>
          </span>
        ))}
        <div className="relative">
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSuggestionsOpen(true);
            }}
            onFocus={() => setSuggestionsOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTag(draft);
              } else if (e.key === "Escape") {
                setSuggestionsOpen(false);
              }
            }}
            // Suggestion buttons preventDefault on mousedown, so blur only fires on a real click-away.
            onBlur={() => commitTag(draft)}
            placeholder="Add a tag"
            className={`w-28 rounded-full border border-dashed bg-transparent px-2.5 py-1 text-xs outline-none ${
              dark
                ? "border-white/30 text-white placeholder:text-white/40 focus:border-white/60"
                : "border-line text-ink focus:border-accent"
            }`}
          />
          {suggestionsOpen && suggestions.length > 0 && (
            <div
              className={`absolute left-0 top-full z-10 mt-1 w-40 overflow-hidden rounded-md border py-1 shadow-lg ${
                dark ? "border-white/20 bg-[#242c34]" : "border-line bg-surface"
              }`}
            >
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commitTag(s);
                  }}
                  className={`block w-full truncate px-2.5 py-1 text-left text-xs ${
                    dark ? "text-white hover:bg-white/10" : "text-ink hover:bg-surface-muted"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Full-size viewer with arrow navigation, zoom/pan, and a caption band for camera info and tags.
export default function Lightbox({
  slides,
  index,
  onIndexChange,
  onClose,
  tagOptions,
}: {
  slides: LightboxSlide[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Tag autocomplete for the caption band's TagEditor. */
  tagOptions?: string[];
}) {
  // Arrows sit over the native video controls, so on video slides they fade out when the mouse idles.
  const [videoControlsIdle, setVideoControlsIdle] = useState(false);
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function resetVideoIdleTimer() {
    setVideoControlsIdle(false);
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = setTimeout(() => setVideoControlsIdle(true), 1000);
  }
  useEffect(() => {
    setVideoControlsIdle(false);
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
  }, [index]);
  useEffect(() => () => {
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
  }, []);
  // Tauri window fullscreen, since requestFullscreen() is unreliable in the frameless desktop
  // window; the DOM API is the fallback in a plain browser.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    tauriCurrentWindow()
      ?.isFullscreen()
      .then(setIsFullscreen)
      .catch(() => {});
  }, []);
  async function toggleFullscreen() {
    const win = tauriCurrentWindow();
    if (win) {
      const next = !isFullscreen;
      await win.setFullscreen(next);
      setIsFullscreen(next);
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      setIsFullscreen(false);
    } else {
      await document.documentElement.requestFullscreen();
      setIsFullscreen(true);
    }
  }
  // Every close path leaves fullscreen first so the window isn't stuck fullscreen.
  async function handleClose() {
    if (isFullscreen) await toggleFullscreen();
    onClose();
  }
  const isFullscreenRef = useRef(isFullscreen);
  useEffect(() => {
    isFullscreenRef.current = isFullscreen;
  }, [isFullscreen]);
  // Same for unmounting via navigation.
  useEffect(
    () => () => {
      if (isFullscreenRef.current) tauriCurrentWindow()?.setFullscreen(false);
    },
    [],
  );
  // Wheel and trackpad-pinch zoom plus drag-to-pan, reset on every slide change.
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Skips the transform transition during a continuous pinch; restarting it per event stutters.
  const wheelZoomingRef = useRef(false);
  const wheelZoomTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);
  // The title-bar drag region would otherwise swallow clicks on the top buttons.
  useEffect(() => {
    markDragBlocked(true);
    return () => markDragBlocked(false);
  }, []);
  useEffect(() => () => {
    if (wheelZoomTimeoutRef.current) clearTimeout(wheelZoomTimeoutRef.current);
  }, []);
  // A missing file shows a placeholder for that slide only; navigation keeps working.
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [index]);

  const videoRef = useRef<HTMLVideoElement>(null);

  // Escape leaves fullscreen first, then closes on a second press. Through the shared stack so a
  // dialog or menu opened over the lightbox closes before it does.
  useEscapeToClose(() => {
    if (isTypingTarget(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
      return;
    }
    if (isFullscreen) void toggleFullscreen();
    else onClose();
  });

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target) || e.defaultPrevented) return;
      const slide = slides[index];
      const video = videoRef.current;
      // On a video, arrows scrub 10s and only move to the next slide past either end.
      if (slide?.videoUrl && video && Number.isFinite(video.duration) && video.duration > 0) {
        if (e.key === "ArrowRight") {
          if (video.currentTime + 10 >= video.duration) onIndexChange((index + 1) % slides.length);
          else video.currentTime = Math.min(video.duration, video.currentTime + 10);
          return;
        }
        if (e.key === "ArrowLeft") {
          if (video.currentTime - 10 <= 0) onIndexChange((index - 1 + slides.length) % slides.length);
          else video.currentTime = Math.max(0, video.currentTime - 10);
          return;
        }
      }
      if (e.key === "ArrowRight") onIndexChange((index + 1) % slides.length);
      else if (e.key === "ArrowLeft") onIndexChange((index - 1 + slides.length) % slides.length);
      else if (e.key >= "1" && e.key <= "5" && slide?.onRate) {
        const rating = Number(e.key);
        slide.onRate(slide.rating === rating ? null : rating);
      } else if (e.key === " " && slide?.videoUrl) {
        e.preventDefault();
        if (video) (video.paused ? video.play() : video.pause());
      } else if (e.key.toLowerCase() === "f") {
        toggleFullscreen();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, slides, onIndexChange, isFullscreen]);

  useEffect(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, [index]);

  // A trackpad pinch arrives as a wheel event with ctrlKey set; a plain scroll pans once zoomed.
  function onWheel(e: ReactWheelEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.ctrlKey) {
      wheelZoomingRef.current = true;
      if (wheelZoomTimeoutRef.current) clearTimeout(wheelZoomTimeoutRef.current);
      wheelZoomTimeoutRef.current = setTimeout(() => {
        wheelZoomingRef.current = false;
      }, 150);
      setScale((s) => {
        const next = Math.min(4, Math.max(1, s - e.deltaY * 0.01));
        if (next === 1) setPan({ x: 0, y: 0 });
        return next;
      });
      return;
    }
    if (scale > 1) {
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  }

  function onDoubleClickZoom(e: ReactMouseEvent) {
    e.stopPropagation();
    setScale((s) => (s > 1 ? 1 : 2));
    setPan({ x: 0, y: 0 });
  }

  function onDragStart(e: ReactMouseEvent) {
    if (scale <= 1) return;
    e.stopPropagation();
    setDragging(true);
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
  }
  function onDragMove(e: ReactMouseEvent) {
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

  const cameraLine = [
    slide.info?.cameraModel,
    slide.info?.lens,
    slide.info?.focalLengthMm ? `${Math.round(Number(slide.info.focalLengthMm))}mm` : null,
    slide.info?.aperture ? `f/${slide.info.aperture}` : null,
    slide.info?.shutter,
    slide.info?.iso ? `ISO ${slide.info.iso}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const durationLabel =
    slide.info?.durationSeconds != null
      ? `${Math.floor(Number(slide.info.durationSeconds) / 60)}:${String(Math.round(Number(slide.info.durationSeconds) % 60)).padStart(2, "0")}`
      : null;
  const takenLabel = formatDate(slide.info?.takenAt, "medium") || null;
  const hasCaptionBand = !!(
    slide.caption ||
    slide.speciesId ||
    slides.length > 1 ||
    cameraLine ||
    durationLabel ||
    takenLabel ||
    (slide.info?.files?.length ?? 0) > 0 ||
    slide.onTagsChange
  );
  const iconButtonClass =
    "rounded-full bg-black/40 p-2.5 text-lg leading-none text-white/80 transition-colors hover:bg-black/60 hover:text-white";

  const videoIdle = !!slide.videoUrl && videoControlsIdle;
  const overlayFadeClass = videoIdle ? "pointer-events-none opacity-0" : "opacity-100";
  const mediaClass = isFullscreen ? "h-full max-h-full w-full max-w-full" : "max-h-[85vh] max-w-full";

  return (
    <div
      className={`fixed inset-0 z-50 bg-black/90 ${videoIdle ? "cursor-none" : ""}`}
      onClick={handleClose}
      onMouseMove={() => {
        if (slide.videoUrl) resetVideoIdleTimer();
      }}
    >
      <div
        className={`relative flex h-full w-full flex-col items-center justify-center overflow-hidden ${
          isFullscreen ? "" : "p-4"
        }`}
      >
        <div className={`absolute right-4 top-4 z-10 flex items-center gap-2 transition-opacity duration-300 ${overlayFadeClass}`}>
          {slide.download && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const { url, filename } = slide.download!;
                downloadFile(url, filename).catch(() => {});
              }}
              className={iconButtonClass}
              aria-label="Download"
              title="Download"
            >
              <svg viewBox="0 0 24 24" className="h-[1.125rem] w-[1.125rem]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />
              </svg>
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleFullscreen();
            }}
            className={iconButtonClass}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFullscreen ? "⤢" : "⛶"}
          </button>
          <button onClick={handleClose} className={iconButtonClass} aria-label="Close">
            ×
          </button>
        </div>

        {slides.length > 1 && (
          <>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onIndexChange((index - 1 + slides.length) % slides.length);
              }}
              className={`absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 p-3 text-xl text-white transition-opacity duration-300 hover:bg-black/60 sm:left-6 ${overlayFadeClass}`}
              aria-label="Previous"
            >
              ‹
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onIndexChange((index + 1) % slides.length);
              }}
              className={`absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 p-3 text-xl text-white transition-opacity duration-300 hover:bg-black/60 sm:right-6 ${overlayFadeClass}`}
              aria-label="Next"
            >
              ›
            </button>
          </>
        )}

        {slide.videoUrl ? (
          <video
            key={slide.videoUrl}
            ref={videoRef}
            src={slide.videoUrl}
            poster={slide.url}
            controls
            // Our own fullscreen button only: the native one detaches the video from this layout.
            controlsList="nofullscreen"
            // No autoPlay: unmuted autoplay is blocked here and leaves the play control disabled.
            className={`${mediaClass} object-contain`}
            onClick={(e) => e.stopPropagation()}
          />
        ) : slide.noPreview ? (
          <div
            className="flex h-64 w-64 flex-col items-center justify-center gap-2 rounded-lg bg-white/10 text-white/70"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-xs font-medium uppercase tracking-wide">RAW</span>
            <span className="text-xs">No preview available</span>
          </div>
        ) : imageFailed ? (
          <PhotoPlaceholder className="h-64 w-64" onClick={(e) => e.stopPropagation()} />
        ) : (
          <img
            src={slide.url}
            alt=""
            draggable={false}
            className={`${mediaClass} select-none object-contain`}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transition: dragging || wheelZoomingRef.current ? "none" : "transform 0.05s ease-out",
              cursor: scale > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
            }}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={onDoubleClickZoom}
            onWheel={onWheel}
            onMouseDown={onDragStart}
            onMouseMove={onDragMove}
            onMouseUp={onDragEnd}
            onMouseLeave={onDragEnd}
            onError={() => setImageFailed(true)}
          />
        )}

        {hasCaptionBand && (isFullscreen ? !!slide.videoUrl : true) && (
          <div
            className={
              isFullscreen
                ? `absolute inset-x-0 bottom-12 z-10 bg-gradient-to-t from-black/70 to-transparent px-4 pb-2 pt-8 text-center text-sm text-white/70 transition-opacity duration-300 ${overlayFadeClass}`
                : "mt-3 w-full max-w-xl shrink-0 text-center text-sm text-white/70"
            }
            onClick={(e) => e.stopPropagation()}
          >
            {(slide.caption || durationLabel) && (
              <p className="text-white">
                {slide.caption}
                {slide.caption && durationLabel && " · "}
                {durationLabel}
              </p>
            )}
            {cameraLine && <p className="mt-0.5 text-xs text-white/50">{cameraLine}</p>}
            {takenLabel && <p className="mt-0.5 text-xs text-white/50">{takenLabel}</p>}
            {slide.info?.files && slide.info.files.length > 0 && (
              // Selectable, with the full stored location on hover, for finding the file yourself.
              <p className="mt-0.5 select-text text-xs text-white/50" onClick={(e) => e.stopPropagation()}>
                {slide.info.files.map((ref, i) => (
                  <span key={ref} title={ref}>
                    {i > 0 && " · "}
                    {fileNameOf(ref)}
                  </span>
                ))}
              </p>
            )}
            {slide.speciesId && (
              <Link to={`/species/${slide.speciesId}`} className="mt-1 inline-block underline hover:text-white">
                View species ↗
              </Link>
            )}
            {slide.onTagsChange && (
              <div className="mt-2 flex justify-center">
                <TagEditor compact dark tags={slide.tags ?? []} onChange={slide.onTagsChange} existingTags={tagOptions} />
              </div>
            )}
            {slides.length > 1 && <p className="mt-1 text-xs text-white/40">{index + 1} / {slides.length}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
