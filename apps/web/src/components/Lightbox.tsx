import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PhotoPlaceholder from "./PhotoPlaceholder";
import { markDragBlocked } from "../lib/modalDragBlock";
import { tauriCurrentWindow } from "../lib/tauri";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { useLatest } from "../hooks/useLatest";
import { useToast } from "../hooks/useToast";
import { errorMessage } from "../lib/errorMessage";
import { formatDate } from "../lib/format";
import { downloadFile } from "../lib/downloadFile";
import { backStateFor } from "../lib/backLabel";

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
    /** What a culling app marked it at import (lib/cullInfo.ts). */
    cull?: string | null;
  } | null;
  tags?: string[] | null;
  onTagsChange?: (tags: string[]) => void;
  /** When set, shows a download button for this slide. */
  download?: { url: string; filename: string } | null;
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
      {/* Centred under the photo in the viewer; left-aligned in menus and dialogs. */}
      <div className={`flex flex-wrap items-center gap-1.5 ${dark ? "justify-center" : ""}`}>
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
                dark ? "border-white/20 bg-[#1c1e1f]" : "border-line bg-surface"
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
  backLabel,
}: {
  slides: LightboxSlide[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Tag autocomplete for the caption band's TagEditor. */
  tagOptions?: string[];
  /** What the species page's back link calls this page, when it has a name (a trip's, an album's). */
  backLabel?: string;
}) {
  // Arrows sit over the native video controls, so on video slides they fade out when the mouse idles.
  const toast = useToast();
  const { t } = useTranslation();
  const location = useLocation();
  const [videoControlsIdle, setVideoControlsIdle] = useState(false);
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function resetVideoIdleTimer() {
    setVideoControlsIdle(false);
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = setTimeout(() => setVideoControlsIdle(true), 1000);
  }
  // The idle state itself resets with the other per-slide state below; its timer stops here.
  useEffect(() => {
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
  }, [index]);
  useEffect(
    () => () => {
      if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
    },
    [],
  );
  // Tauri window fullscreen, since requestFullscreen() is unreliable in the frameless desktop
  // window; the DOM API is the fallback in a plain browser. `isFullscreen` is the viewer's own
  // edge-to-edge layout: when the window is already fullscreen (the user's choice, from the green
  // button or elsewhere), the viewer only switches its layout and never takes the window out.
  const [isFullscreen, setIsFullscreen] = useState(false);
  // True only while the viewer itself put the window into fullscreen, so only then does it undo it.
  const ownsWindowFullscreen = useRef(false);
  // The whole app is fullscreen already (the desktop window, or the browser page), so the viewer has
  // nothing to offer: its button hides unless it's what made the window fullscreen.
  const appFullscreen = useAppFullscreen();
  const canToggleFullscreen = isFullscreen || !appFullscreen;
  async function toggleFullscreen() {
    const win = tauriCurrentWindow();
    if (isFullscreen) {
      setIsFullscreen(false);
      if (!ownsWindowFullscreen.current) return;
      ownsWindowFullscreen.current = false;
      if (win) await win.setFullscreen(false);
      else if (document.fullscreenElement) await document.exitFullscreen();
      return;
    }
    setIsFullscreen(true);
    const alreadyFullscreen = win ? await win.isFullscreen().catch(() => false) : !!document.fullscreenElement;
    if (alreadyFullscreen) return;
    ownsWindowFullscreen.current = true;
    if (win) await win.setFullscreen(true);
    else await document.documentElement.requestFullscreen();
  }
  // Every close path leaves the viewer's fullscreen first so the window isn't stuck fullscreen.
  async function handleClose() {
    if (isFullscreen) await toggleFullscreen();
    onClose();
  }
  // Same for unmounting via navigation.
  useEffect(
    () => () => {
      if (!ownsWindowFullscreen.current) return;
      const win = tauriCurrentWindow();
      if (win) void win.setFullscreen(false);
      else if (document.fullscreenElement) void document.exitFullscreen();
    },
    [],
  );
  // Wheel and trackpad-pinch zoom plus drag-to-pan, reset on every slide change.
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Skips the transform transition during a continuous pinch or trackpad pan; restarting it per
  // event stutters.
  const [wheeling, setWheeling] = useState(false);
  const wheelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  useEffect(
    () => () => {
      if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);
    },
    [],
  );
  // A missing file shows a placeholder for that slide only; navigation keeps working.
  const [imageFailed, setImageFailed] = useState(false);

  // A new slide starts unzoomed, with its controls showing and no failure carried over.
  const [shownIndex, setShownIndex] = useState(index);
  if (shownIndex !== index) {
    setShownIndex(index);
    setVideoControlsIdle(false);
    setImageFailed(false);
    setScale(1);
    setPan({ x: 0, y: 0 });
  }

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

  // The handler outlives renders; the ref keeps fullscreen toggling on the current state.
  const toggleFullscreenRef = useLatest(toggleFullscreen);
  const canToggleFullscreenRef = useLatest(canToggleFullscreen);
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target) || e.defaultPrevented) return;
      // Cmd+0 (Ctrl+0), as in Lightroom: back to the whole photo, fitted to the window.
      if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        setScale(1);
        setPan({ x: 0, y: 0 });
        return;
      }
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
        if (video) video.paused ? video.play() : video.pause();
      } else if (e.key.toLowerCase() === "f" && canToggleFullscreenRef.current) {
        void toggleFullscreenRef.current();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [index, slides, onIndexChange, toggleFullscreenRef, canToggleFullscreenRef]);

  // The latest zoom and pan, read by events that arrive faster than renders (a pinch); zoomAt also
  // writes it straight away so the next event builds on this one.
  const viewRef = useLatest({ scale, pan });
  // What the photo is drawn at right now, which its on-screen box reflects: during a fast pinch
  // several events land before the next frame, so this lags viewRef.
  const drawnPanRef = useLatest(pan);

  const photoRef = useRef<HTMLImageElement>(null);
  /** Keeps the zoomed photo covering its own box: it can't be pushed past its edges, and at its
   *  normal size it doesn't move at all. */
  function clampPan(next: { x: number; y: number }, atScale: number) {
    const photo = photoRef.current;
    if (!photo || atScale <= 1) return { x: 0, y: 0 };
    // offsetWidth/Height are the untransformed size; zoomed, it overhangs by (scale - 1) / 2 a side.
    const maxX = ((atScale - 1) * photo.offsetWidth) / 2;
    const maxY = ((atScale - 1) * photo.offsetHeight) / 2;
    return { x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) };
  }

  /** Zooms to `next` keeping the photo's point under (clientX, clientY) where it is. The photo
   *  scales about its own centre, so the pan moves by how far that point is from the centre. */
  function zoomAt(next: number, clientX: number, clientY: number, photo: Element) {
    const { scale: current, pan: currentPan } = viewRef.current;
    if (next <= 1) {
      viewRef.current = { scale: 1, pan: { x: 0, y: 0 } };
      setScale(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    const box = photo.getBoundingClientRect();
    // The drawn box's centre is the untransformed centre moved by the drawn pan (scaling is about
    // the centre, so it doesn't move it).
    const dx = clientX - (box.left + box.width / 2 - drawnPanRef.current.x);
    const dy = clientY - (box.top + box.height / 2 - drawnPanRef.current.y);
    const nextPan = clampPan(
      { x: dx - (next / current) * (dx - currentPan.x), y: dy - (next / current) * (dy - currentPan.y) },
      next,
    );
    viewRef.current = { scale: next, pan: nextPan };
    setScale(next);
    setPan(nextPan);
  }

  // A trackpad pinch arrives as a wheel event with ctrlKey set; a plain scroll pans once zoomed.
  function onWheel(e: ReactWheelEvent) {
    e.preventDefault();
    e.stopPropagation();
    setWheeling(true);
    if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);
    wheelTimeoutRef.current = setTimeout(() => setWheeling(false), 150);
    if (e.ctrlKey) {
      const next = Math.min(4, Math.max(1, viewRef.current.scale - e.deltaY * 0.01));
      zoomAt(next, e.clientX, e.clientY, e.currentTarget);
      return;
    }
    const { scale: current, pan: currentPan } = viewRef.current;
    if (current > 1) {
      const nextPan = clampPan({ x: currentPan.x - e.deltaX, y: currentPan.y - e.deltaY }, current);
      viewRef.current = { scale: current, pan: nextPan };
      setPan(nextPan);
    }
  }

  function onDoubleClickZoom(e: ReactMouseEvent) {
    e.stopPropagation();
    zoomAt(viewRef.current.scale > 1 ? 1 : 2, e.clientX, e.clientY, e.currentTarget);
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
    setPan(clampPan({ x: d.panX + (e.clientX - d.startX), y: d.panY + (e.clientY - d.startY) }, scale));
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
  // Left out when the caption already gives the date (the Gallery's and species page's do).
  const fullDate = formatDate(slide.info?.takenAt, "medium");
  const takenLabel = fullDate && !slide.caption?.includes(formatDate(slide.info?.takenAt)) ? fullDate : null;
  const hasCaptionBand = !!(
    slide.caption ||
    slide.speciesId ||
    slides.length > 1 ||
    cameraLine ||
    durationLabel ||
    takenLabel ||
    (slide.info?.files?.length ?? 0) > 0 ||
    !!slide.info?.cull ||
    slide.onTagsChange
  );
  // A see-through light grey, to stand out on the black backdrop. The corner buttons are a fixed square with the
  // glyph centred, so each is a circle whatever the character's shape; the arrows are the same tall
  // ovals as the species page's photo carousel.
  const iconButtonClass =
    "flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-base leading-none text-white transition-colors hover:bg-white/20";
  const arrowButtonClass =
    "absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 px-2.5 py-1 text-lg text-white transition-opacity duration-300 hover:bg-white/20";

  const videoIdle = !!slide.videoUrl && videoControlsIdle;
  // The controls and details step aside while a video plays untouched or the photo is zoomed in.
  const overlayFadeClass = videoIdle || scale > 1 ? "pointer-events-none opacity-0" : "opacity-100";
  // Outside fullscreen the photo shrinks to whatever the caption below leaves, rather than taking a
  // fixed share of the window and pushing past its top on a short one.
  const mediaClass = isFullscreen ? "h-full max-h-full w-full max-w-full" : "min-h-0 max-w-full";

  // On document.body, like Modal: an ancestor with a transform or filter (the species page's photo)
  // would otherwise size this fixed layer to itself instead of the window.
  return createPortal(
    <div
      data-overlay
      className={`fixed inset-0 z-50 bg-black/90 ${videoIdle ? "cursor-none" : ""}`}
      onClick={handleClose}
      onMouseMove={() => {
        if (slide.videoUrl) resetVideoIdleTimer();
      }}
    >
      <div
        // A video keeps a band clear above it: WebKit puts its volume and picture-in-picture
        // controls in the video's top corner, under the viewer's own buttons otherwise.
        className={`relative flex h-full w-full flex-col items-center justify-center overflow-hidden ${
          // pt-14: clear of the download, fullscreen and close buttons along the top.
          slide.videoUrl ? "px-4 py-16" : isFullscreen ? "" : "px-4 pb-4 pt-14"
        }`}
      >
        <div
          className={`absolute right-4 top-4 z-10 flex items-center gap-2 transition-opacity duration-300 ${overlayFadeClass}`}
        >
          {slide.download && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const { url, filename } = slide.download!;
                downloadFile(url, filename).catch((err) =>
                  toast.error(errorMessage(err, "Couldn't download this file")),
                );
              }}
              className={iconButtonClass}
              aria-label="Download"
              title="Download"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-[1.125rem] w-[1.125rem]"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />
              </svg>
            </button>
          )}
          {canToggleFullscreen && (
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
          )}
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
              className={`${arrowButtonClass} left-2 sm:left-6 ${overlayFadeClass}`}
              aria-label="Previous"
            >
              ‹
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onIndexChange((index + 1) % slides.length);
              }}
              className={`${arrowButtonClass} right-2 sm:right-6 ${overlayFadeClass}`}
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
            ref={photoRef}
            src={slide.url}
            alt=""
            draggable={false}
            className={`${mediaClass} select-none object-contain`}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transition: dragging || wheeling ? "none" : "transform 0.05s ease-out",
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
                : `mt-3 w-full max-w-3xl shrink-0 text-center text-sm text-white/70 transition-opacity duration-300 ${overlayFadeClass}`
            }
            onClick={(e) => e.stopPropagation()}
          >
            {/* Kept to a few lines so the photo above gets the height on a small window. */}
            {(slide.caption || durationLabel || slide.speciesId) && (
              <p className="text-white">
                {slide.caption}
                {slide.caption && durationLabel && " · "}
                {durationLabel}
                {slide.speciesId && (
                  <>
                    {(slide.caption || durationLabel) && <span className="text-white/40"> · </span>}
                    <Link
                      to={`/species/${slide.speciesId}`}
                      state={backStateFor(location, t, backLabel)}
                      className="text-white/70 underline hover:text-white"
                    >
                      View species ↗
                    </Link>
                  </>
                )}
              </p>
            )}
            {(cameraLine || takenLabel || slide.info?.cull) && (
              <p className="mt-0.5 text-xs text-white/50">
                {[cameraLine, takenLabel, slide.info?.cull].filter(Boolean).join(" · ")}
              </p>
            )}
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
            {(slide.onTagsChange || slides.length > 1) && (
              <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
                {slide.onTagsChange && (
                  <TagEditor
                    compact
                    dark
                    tags={slide.tags ?? []}
                    onChange={slide.onTagsChange}
                    existingTags={tagOptions}
                  />
                )}
                {slides.length > 1 && (
                  <span className="text-xs text-white/40">
                    {index + 1} / {slides.length}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Whether the app itself is fullscreen: the desktop window (main.tsx marks <html data-fullscreen>)
 *  or, in a browser, the page. */
function useAppFullscreen(): boolean {
  const read = () => document.documentElement.hasAttribute("data-fullscreen") || !!document.fullscreenElement;
  const [fullscreen, setFullscreen] = useState(read);
  useEffect(() => {
    const sync = () => setFullscreen(read());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-fullscreen"] });
    document.addEventListener("fullscreenchange", sync);
    return () => {
      observer.disconnect();
      document.removeEventListener("fullscreenchange", sync);
    };
  }, []);
  return fullscreen;
}
