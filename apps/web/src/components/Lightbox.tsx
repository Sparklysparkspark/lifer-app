import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import PhotoPlaceholder from "./PhotoPlaceholder";
import { markDragBlocked } from "../lib/modalDragBlock";
import { tauriCurrentWindow } from "../lib/tauri";

export interface LightboxSlide {
  url: string;
  /** Set only for a video slide — real playback with native browser controls (play/pause,
   *  scrubber, volume, fullscreen), served from /api/photos/:id/video. The zoom/pan/pinch
   *  gestures the image view below uses are image-specific and don't apply, so a video slide
   *  renders a plain <video controls> instead. */
  videoUrl?: string | null;
  /** Set only for a camera RAW slide with no real preview to show (the import screen's own
   *  blob URL for a RAW file — browsers can't decode raw sensor data, so `url` would just be a
   *  broken image, same reasoning PhotoImportRows' own row thumbnail already follows). Shows a
   *  RAW badge instead of ever attempting `<img src={url}>`. */
  noPreview?: boolean;
  caption?: string | null;
  /** Current quality rating (1-5) plus a setter — only present when the caller supports rating
   *  from the grid (every current caller does). Lets the `1`-`5` keys set a rating without the
   *  page needing to reach back into Lightbox's own index state to know which capture is open. */
  rating?: number | null;
  onRate?: (rating: number | null) => void;
  // Only set by callers that aren't already ON that species' own page (e.g. GalleryPage,
  // browsing across many species at once) — SpeciesDetailPage's own lightbox usage has no
  // reason to link back to the page it's already showing, so it just omits this.
  speciesId?: string | null;
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
    // Only meaningful for a video slide — shown as its own row alongside whatever EXIF a
    // camera happened to write into the video file, same info panel a photo gets.
    durationSeconds?: number | string | null;
  } | null;
  // Custom free-text tags a photographer assigns per photo — only present when the caller
  // supports editing (every current caller does), same optional pattern as rating/onRate above.
  tags?: string[] | null;
  onTagsChange?: (tags: string[]) => void;
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
  /** Every tag this user has used anywhere else, for autocomplete — so a tag you've already
   *  coined once (e.g. "flight shot") is easy to reuse consistently on another photo instead of
   *  retyping it and risking a near-duplicate ("Flight shot" vs "flight shot"). Omit to disable
   *  the suggestion dropdown entirely (no list fetched yet, or none exist). */
  existingTags?: string[];
  label?: string;
  /** Drops the "Tags" heading, top border, and top margin — for embedding inline in a toolbar
   *  row that already provides its own label/spacing, rather than as its own standalone section
   *  (the info panel, a menu popover). */
  compact?: boolean;
  /** For embedding over Lightbox's always-black backdrop, which doesn't follow the app's own
   *  light/dark theme — the normal text-ink/text-muted/bg-surface-muted tokens flip to a dark
   *  navy in light mode, which reads as invisible (dim near-black text) against black. Swaps
   *  every token for a fixed white-on-translucent-black treatment instead. */
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
            // A suggestion button's own onMouseDown (below) fires and commits the tag BEFORE
            // this blur would — preventDefault there stops the input from ever losing focus in
            // the first place, so this still safely commits whatever's typed for a plain
            // click-away with no suggestion involved.
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

// Full-size image viewer (Immich-style click-to-view), with left/right navigation and
// Escape/backdrop-click to close. Camera/duration info sits in the same bottom caption band as
// the filename/species link — always visible, never behind a separate info-panel click, the
// same way a fullscreen photo viewer (Photos.app, Preview) shows a filename bar under the image.
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
  /** Every tag this user has used anywhere else — passed straight through to the bottom
   *  caption band's own TagEditor for autocomplete. Omit if the caller doesn't support tag
   *  editing at all. */
  tagOptions?: string[];
}) {
  // Video's own native controls (scrubber, volume, fullscreen) sit right where the next/
  // previous arrows are absolutely positioned, so the arrows need to get out of the way once the
  // mouse stops moving — mirrors how those native controls themselves auto-hide. Only applies to
  // video slides; photo slides keep the arrows always visible since there's no overlapping
  // control bar to protect.
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
  // Real window-level fullscreen (the native green-traffic-light kind), not the DOM Fullscreen
  // API — this app's frameless window doesn't reliably support requestFullscreen() on a
  // desktop build (confirmed: the button silently did nothing), while Tauri's own window
  // fullscreen is the same mechanism the OS's own fullscreen control already uses, so it always
  // works. Falls back to the DOM API only when running outside Tauri (self-hosted in a real
  // browser tab), where that API is the standard, reliable one.
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
  // Only the Escape handler used to un-fullscreen before closing — clicking the backdrop or the
  // X button called onClose() directly, leaving the whole (Tauri) window stuck in native
  // fullscreen after the lightbox itself was gone. Every close path now goes through this.
  async function handleClose() {
    if (isFullscreen) await toggleFullscreen();
    onClose();
  }
  const isFullscreenRef = useRef(isFullscreen);
  useEffect(() => {
    isFullscreenRef.current = isFullscreen;
  }, [isFullscreen]);
  // Covers unmounting via navigation-away (parent stops rendering the Lightbox without ever
  // calling onClose) — the same window-fullscreen-stuck bug via a different exit path.
  useEffect(
    () => () => {
      if (isFullscreenRef.current) tauriCurrentWindow()?.setFullscreen(false);
    },
    [],
  );
  // Scroll-wheel/trackpad-pinch zoom (macOS/WKWebView reports a trackpad pinch as a wheel
  // event, so this covers both without separate touch-gesture handling) plus drag-to-pan once
  // zoomed in. Reset whenever the slide changes or the info panel toggles — panning/zoom state
  // from one photo has no business carrying over to the next.
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // A continuous wheel/trackpad-pinch gesture fires many events per second, each setting a new
  // scale — applying the transform transition to EVERY one of those meant each new value
  // interrupted the previous one's still-running 50ms transition and restarted it, which is
  // what actually read as stutter (not the state updates themselves being slow). Tracked as a
  // ref, not state, since it only gates a style value and shouldn't itself trigger a render;
  // cleared shortly after the gesture goes quiet so a later discrete change (e.g. double-click)
  // still gets its smooth transition back.
  const wheelZoomingRef = useRef(false);
  const wheelZoomTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Body scroll was never actually locked while the lightbox is open — its own backdrop
  // scrolls (overflow-y-auto, for the info panel's tall layout), but the page underneath kept
  // scrolling right along with it on any wheel/trackpad input that missed the photo itself.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);
  // The close/info buttons live in the same top-of-window band TitleBarDragRegion always sits
  // above (see its own comment) — without this, that region wins the browser's hit-test there
  // and both buttons silently do nothing.
  useEffect(() => {
    markDragBlocked(true);
    return () => markDragBlocked(false);
  }, []);
  useEffect(() => () => {
    if (wheelZoomTimeoutRef.current) clearTimeout(wheelZoomTimeoutRef.current);
  }, []);
  // A slide whose file has moved/been deleted/never existed shouldn't take the whole viewer
  // down with it — falls back to a placeholder for just that one slide, keeping close/arrows
  // fully working so a broken photo is never a dead end you have to reload the page to escape.
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [index]);

  // Only one of the two <video> elements below (immersive vs info-panel view) is ever mounted
  // at once, so a single ref covers whichever one is showing.
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
    }
    function handleKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      const slide = slides[index];
      // Escape backs out one level at a time — out of fullscreen first (matching every other
      // fullscreen video/media viewer), THEN closes the viewer on a second press, rather than
      // both at once dumping you all the way back to the grid.
      if (e.key === "Escape") {
        if (isFullscreen) toggleFullscreen();
        else onClose();
        return;
      }
      const video = videoRef.current;
      // For a video, left/right scrub 10 seconds instead of jumping to the next/previous
      // slide — the same convention as YouTube/QuickTime. Only falls through to actual slide
      // navigation once a skip would run past the start/end, so hitting the edge continues
      // naturally into the next or previous photo/video rather than needing a second key press.
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
  }, [index, slides, onIndexChange, onClose, isFullscreen]);

  useEffect(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, [index]);

  // Trackpads report a two-finger pinch as a wheel event with ctrlKey set to true — a browser
  // convention that exists specifically so a page can tell a pinch apart from an ordinary
  // two-finger scroll (which fires the same event type, just without ctrlKey). Zoom only reacts
  // to the former; a plain scroll instead pans the photo horizontally/vertically once zoomed in,
  // matching how a photo viewer is expected to behave rather than zooming on every scroll.
  function onWheel(e: React.WheelEvent) {
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

  // A single compact line joining whatever camera EXIF exists — "Canon EOS R7 · 400mm · f/5.6 ·
  // 1/1000 · ISO 800" — rather than a full labeled-row table, since this now lives in the
  // bottom caption band alongside the filename/species link, not a dedicated detail page.
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
  const takenLabel = slide.info?.takenAt ? new Date(slide.info.takenAt).toLocaleDateString() : null;
  const hasCaptionBand = !!(
    slide.caption ||
    slide.speciesId ||
    slides.length > 1 ||
    cameraLine ||
    durationLabel ||
    takenLabel ||
    slide.onTagsChange
  );
  // One consistent circular translucent button for every icon action — fullscreen and close
  // share it now, instead of each having its own ad hoc size/opacity.
  const iconButtonClass =
    "rounded-full bg-black/40 p-2.5 text-lg leading-none text-white/80 transition-colors hover:bg-black/60 hover:text-white";

  // Fades with mouse idle for video (mirroring its own native controls' auto-hide); always
  // visible for a photo, which has no competing native control bar to protect.
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
            // Fullscreen is handled entirely by our own button (real window-manager
            // fullscreen — see toggleFullscreen's own comment), never the native control's own
            // fullscreen icon: that triggers a SEPARATE browser-native fullscreen presentation
            // for just the <video> element, detached from this component's layout, which left
            // mouse-move tracking (for the auto-hiding controls) still measuring the video's
            // old, small on-page position instead of the new fullscreen bounds. One fullscreen
            // mechanism only, so there's nothing left to get out of sync.
            controlsList="nofullscreen"
            // No autoPlay: this plays with sound, and the embedded webview's autoplay policy
            // blocks unmuted playback that isn't the DIRECT result of a click — opening the
            // lightbox is one render removed from the click that triggered it, so the browser
            // treats the attempt as blocked rather than user-initiated. That failed attempt is
            // exactly what left the native play control showing its "not allowed" (slashed)
            // icon instead of an actual working play button. Pressing play manually is a real,
            // synchronous user gesture, so it always works — better than a broken autoplay
            // attempt that poisons the control's state before the user gets a chance to.
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
