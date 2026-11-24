import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PhotoPlaceholder from "./PhotoPlaceholder";
import StarRating from "./StarRating";
import CaptureEditModal from "./CaptureEditModal";
import CoordinatesModal from "./CoordinatesModal";
import type { Appearance } from "@lifer/shared";
import { AppearanceBadges, AppearanceModal } from "./Appearance";
import { NO_APPEARANCE } from "../lib/appearance";
import { formatCoordinates } from "../lib/coordinates";
import TagEditor from "./TagEditor";
import type { SpeciesResult } from "./SpeciesPicker";
import Tip from "./Tip";
import { markDragBlocked } from "../lib/modalDragBlock";
import { tauriCurrentWindow } from "../lib/tauri";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { useLatest } from "../hooks/useLatest";
import { isTypingTarget } from "../hooks/useKeyboardShortcuts";
import { matches, shortcutLabel, type KeyAction } from "../lib/keymap";
import { Tooltip } from "./Tooltip";
import ZoomPane from "./ZoomPane";
import PhotoArrows from "./PhotoArrows";
import WindowTitleBar from "./WindowTitleBar";
import { FIT, zoomView, type View } from "../lib/compareZoom";

const RATE_ACTIONS: KeyAction[] = ["rate1", "rate2", "rate3", "rate4", "rate5"];
// Shift+0 to 5: rate (0 clears) and move on, as in Lightroom.
const RATE_NEXT_ACTIONS: KeyAction[] = [
  "rateClearNext",
  "rate1Next",
  "rate2Next",
  "rate3Next",
  "rate4Next",
  "rate5Next",
];
import { useToast } from "../hooks/useToast";
import { useOpenInEditors } from "../hooks/useOpenInEditors";
import { useApiRoute } from "../lib/resource";
import { api, apiPath } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import { openExternal } from "../lib/openExternal";
import { formatDate, formatDuration, formatNumber } from "../lib/format";
import { downloadWithToast } from "../lib/downloadFile";
import { ignore } from "../lib/ignore";
import { backStateFor } from "../lib/backLabel";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { sharpestShown } from "./ProgressiveImg";
import { VersionStrip, usePhotoVersions } from "./PhotoVersions";
import { StackIcon } from "./PhotoTile";
import { openPhotoVersions, photoVersionsPanel, type PhotoVersion } from "../lib/photoVersions";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

/** A slide's identity across reloads; trip slides carry no captureId, and their URL is per photo. */
function slideKey(slide: LightboxSlide | undefined): string | undefined {
  return slide && (slide.captureId ?? slide.url);
}

/** m:ss.cc, to the hundredth, so the saved frame is named exactly. */
function frameTimeLabel(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}.${String(Math.floor((seconds - whole) * 100)).padStart(2, "0")}`;
}

export interface LightboxSlide {
  url: string;
  /** Video slides play in a plain <video controls>; zoom and pan are image-only. */
  videoUrl?: string | null;
  /** A sound recording: its waveform is the picture, with a player under it. */
  audioUrl?: string | null;
  /** Video slides: where a frame is saved as a photo; adds frame stepping and "Save frame". */
  frameUrl?: string | null;
  /** A RAW file the browser can't decode: shows a badge instead of a broken <img>. */
  noPreview?: boolean;
  /** The photo's thumbnail: its sharpest copy already loaded shows at once while `url` decodes. */
  thumbUrl?: string | null;
  /** The photo's upright size. */
  width?: number | null;
  height?: number | null;
  caption?: string | null;
  /** 1-5 rating plus setter; shows the stars and lets the 1-5 keys rate the open slide. */
  rating?: number | null;
  onRate?: (rating: number | null) => void;
  /** Adds "Correct the ID", for the viewer's own photos. */
  onReassign?: (species: SpeciesResult) => void;
  /** The slide's photo, so "Correct the ID" can offer its likeliest other species. */
  captureId?: string;
  // Adds a "View species" link; omitted on the species page itself.
  speciesId?: string | null;
  /** Adds "Similar photos", a link to the photo's near-identical group. */
  similarHref?: string | null;
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
  /** How the animal looks; with onAppearanceChange (and captureId) it can be set here. */
  appearance?: Appearance | null;
  onAppearanceChange?: (changes: Partial<Appearance>) => void;
  /** The photo's GPS point. With onChange (and captureId), it can be typed or cleared here. */
  coordinates?: {
    lat: number | null;
    lon: number | null;
    /** The photo has a region, so none is offered from the point. */
    hasRegion: boolean;
    onChange?: (point: { lat: number; lon: number } | null, region: { id: string; name: string } | null) => void;
  } | null;
  /** When set, shows a download button for this slide. */
  download?: { url: string; filename: string } | null;
  /** After a change to the photo's versions, e.g. to reload the shown photo. */
  onVersionsChange?: () => void;
  /** After "Save frame" adds a photo, so the page behind lists it at once. */
  onFrameSaved?: () => void;
}

function fileNameOf(ref: string): string {
  return ref.split(/[\\/]/).pop() || ref;
}

// Neighbours kept decoded each way, and the most decoded pixels they may hold between them.
const PRELOAD_EACH_WAY = 2;
const PRELOAD_MAX_BYTES = 192 * 1024 * 1024;

/** Decodes the open photo off the main thread and keeps its neighbours decoded, so the viewer
 *  swaps its placeholder for a ready image and paging never shows an empty frame. Returns the
 *  URLs that are ready to draw. */
function useDecodedPhotos(slides: LightboxSlide[], index: number): ReadonlySet<string> {
  const [ready, setReady] = useState<ReadonlySet<string>>(() => new Set());
  const held = useRef(new Map<string, HTMLImageElement>());
  useEffect(() => {
    const images = held.current;
    const current = slides[index]?.url;
    const wanted = new Set<string>();
    // Open slide first, then +1, -1, +2, -2.
    for (let d = 0; d <= PRELOAD_EACH_WAY * 2; d++) {
      const s = slides[(index + (d % 2 ? (d + 1) / 2 : -d / 2) + slides.length * 3) % slides.length];
      if (s && !s.videoUrl && !s.audioUrl && !s.noPreview) wanted.add(s.url);
    }
    const drop = (url: string) => {
      images.get(url)!.src = "";
      images.delete(url);
    };
    // A dropped URL stays in `ready`: coming back to it skips the placeholder, as before preloading.
    for (const url of [...images.keys()]) if (!wanted.has(url)) drop(url);
    for (const url of wanted) {
      if (images.has(url)) continue;
      const img = new Image();
      img.src = url;
      images.set(url, img);
      // A failed decode is marked ready too, so the <img> shows its own error.
      const done = () => {
        if (images.get(url) !== img) return;
        const bytes = [...images.values()].reduce((n, i) => n + i.naturalWidth * i.naturalHeight * 4, 0);
        if (bytes > PRELOAD_MAX_BYTES && url !== current) return drop(url);
        setReady((prev) => new Set(prev).add(url));
      };
      // jsdom has no decode().
      (typeof img.decode === "function" ? img.decode() : Promise.resolve()).then(done, done);
    }
  }, [slides, index]);
  useEffect(() => {
    const images = held.current;
    return () => {
      for (const img of images.values()) img.src = "";
      images.clear();
    };
  }, []);
  return ready;
}

// Full-size viewer with arrow navigation, zoom/pan, and a caption band for camera info and tags.
export default function Lightbox({
  slides,
  index,
  onIndexChange,
  onClose,
  tagOptions,
  morphOptions,
  backLabel,
  total,
}: {
  slides: LightboxSlide[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Tag autocomplete for the caption band's TagEditor. */
  tagOptions?: string[];
  /** Morphs already used, offered in the Appearance dialog. */
  morphOptions?: string[];
  /** What the species page's back link calls this page, when it has a name (a trip's, an album's). */
  backLabel?: string;
  /** How many photos the page has in all, when only some are loaded as slides, so the counter
   *  agrees with the page's own count. */
  total?: number;
}) {
  // Arrows sit over the native video controls, so on video slides they fade out when the mouse idles.
  const toast = useToast();
  const { t } = useTranslation();
  const location = useLocation();
  const [videoControlsIdle, setVideoControlsIdle] = useState(false);
  // shortcut: the viewer offers the last-used editor only; the photo menus list them all.
  const { editors, openIn } = useOpenInEditors();
  const checklist = useApiRoute(
    slides[index]?.captureId ? apiPath("/captures/{id}/ebird", { id: slides[index].captureId }) : null,
  ).data?.checklists[0];
  // Each dialog holds the slide it opened on, so a reload that moves the slides can't retarget it.
  const [correcting, setCorrecting] = useState<LightboxSlide | null>(null);
  const [editingCoordinates, setEditingCoordinates] = useState<LightboxSlide | null>(null);
  const [editingAppearance, setEditingAppearance] = useState<LightboxSlide | null>(null);
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
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
  // Never rejects: a refused fullscreen request just leaves the layout as it was.
  async function toggleFullscreen() {
    const win = tauriCurrentWindow();
    try {
      if (isFullscreen) {
        setIsFullscreen(false);
        if (!ownsWindowFullscreen.current) return;
        ownsWindowFullscreen.current = false;
        if (win) await win.setFullscreen(false);
        else if (document.fullscreenElement) await document.exitFullscreen();
        return;
      }
      const alreadyFullscreen = win ? await win.isFullscreen().catch(() => false) : !!document.fullscreenElement;
      if (!alreadyFullscreen) {
        // Set before the await so closing mid-request still undoes it.
        ownsWindowFullscreen.current = true;
        try {
          if (win) await win.setFullscreen(true);
          else await document.documentElement.requestFullscreen();
        } catch (err) {
          ownsWindowFullscreen.current = false;
          throw err;
        }
      }
      setIsFullscreen(true);
    } catch (err) {
      ignore("Couldn't change fullscreen")(err);
    }
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
  // Zoom and pan (ZoomPane does the gestures), reset on every slide change.
  const [view, setView] = useState<View>(FIT);

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
  // A missing file shows a placeholder for that slide only; navigation keeps working.
  const [imageFailed, setImageFailed] = useState(false);

  // The version on screen when the user switched away from the slide's own photo.
  const [versionId, setVersionId] = useState<string | null>(null);
  // A new slide starts unzoomed, with its controls showing and no failure carried over.
  const [shownIndex, setShownIndex] = useState(index);
  // The photo on screen and the slides it was found in. A rating or edit can re-sort or filter the
  // list under the viewer, so it follows the photo, not the position.
  const shown = useRef({ slides, key: slideKey(slides[index]) });
  const go = useCallback(
    (to: number) => {
      shown.current.key = slideKey(slides[to]);
      onIndexChange(to);
    },
    [slides, onIndexChange],
  );
  useLayoutEffect(() => {
    const { slides: before, key } = shown.current;
    shown.current.slides = slides;
    if (before === slides || slideKey(slides[index]) === key) {
      shown.current.key = slideKey(slides[index]);
      return;
    }
    // Gone: whatever now fills its place, or the last photo.
    const at = slides.findIndex((s) => slideKey(s) === key);
    const to = at >= 0 ? at : Math.min(index, slides.length - 1);
    if (to < 0) return;
    shown.current.key = slideKey(slides[to]);
    if (to !== index) onIndexChange(to);
  }, [slides, index, onIndexChange]);
  if (shownIndex !== index) {
    setShownIndex(index);
    setVideoControlsIdle(false);
    setImageFailed(false);
    setView(FIT);
    setVersionId(null);
  }
  const current = slides[index];
  const { versions, groupCaptureId } = usePhotoVersions(
    current?.captureId && !current.videoUrl && !current.audioUrl ? current.captureId : null,
  );
  // The slide's own photo among its versions, and the one on screen.
  const ownVersion = versions.find((v) => v.photoId && current?.url.includes(v.photoId));
  const activeVersion = versions.find((v) => v.captureId === versionId) ?? ownVersion;
  function showVersion(next: PhotoVersion) {
    const from = activeVersion;
    setImageFailed(false);
    setVersionId(next.captureId === ownVersion?.captureId ? null : next.captureId);
    // Zoom stays put across versions of one size, so details compare in place.
    if (!from || from.width !== next.width || from.height !== next.height) setView(FIT);
  }
  function stepVersion(by: 1 | -1) {
    const at = versions.findIndex((v) => v.captureId === activeVersion?.captureId);
    showVersion(versions[(at + by + versions.length) % versions.length]);
  }
  // Any still photo: a photo without versions yet is the one to link to its original.
  const versionsPanelOpen = photoVersionsPanel.use() != null;
  useKeyboardShortcuts(
    {
      versionsShow: () => current?.captureId && openPhotoVersions(current.captureId, current.onVersionsChange),
      versionLinkTo: (e) => {
        e.preventDefault();
        if (current?.captureId && versions.length <= 1)
          openPhotoVersions(current.captureId, current.onVersionsChange, true);
      },
    },
    {
      enabled:
        !!current?.captureId &&
        !current.videoUrl &&
        !current.audioUrl &&
        !versionsPanelOpen &&
        !correcting &&
        !editingCoordinates &&
        !editingAppearance,
    },
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  // Where the video stands, to name the exact frame "Save frame" would take.
  const [videoTime, setVideoTime] = useState(0);
  async function saveFrame(frameUrl: string, onSaved?: () => void) {
    const at = videoRef.current?.currentTime ?? 0;
    try {
      const res = await api.post<{ duplicate?: boolean }>(frameUrl, { atSeconds: at });
      toast.success(t(res.duplicate ? "lightbox.frameDuplicate" : "lightbox.frameSaved"));
      if (!res.duplicate) onSaved?.();
    } catch (err) {
      toast.error(errorMessage(err, t("lightbox.frameFailed")));
    }
  }

  // Escape leaves fullscreen first, then closes on a second press. Through the shared stack so a
  // dialog or menu opened over the lightbox closes before it does.
  const isTopLayer = useEscapeToClose(() => {
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
  const versionsRef = useLatest(versions);
  const stepVersionRef = useLatest(stepVersion);
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (correcting || editingCoordinates || editingAppearance || isTypingTarget(e.target) || e.defaultPrevented)
        return;
      // A dialog or another viewer over this one takes the keys (a Versions dialog's own viewer).
      if (!isTopLayer()) return;
      const slide = slides[index];
      const video = videoRef.current;
      const hasDuration = !!video && Number.isFinite(video.duration) && video.duration > 0;
      if (versionsRef.current.length > 1 && (matches(e, "versionNext") || matches(e, "versionPrevious"))) {
        e.preventDefault();
        stepVersionRef.current(matches(e, "versionNext") ? 1 : -1);
      } else if (matches(e, "zoomFit")) {
        e.preventDefault();
        setView(FIT);
      } else if (matches(e, "zoomIn") || matches(e, "zoomOut")) {
        e.preventDefault();
        const factor = matches(e, "zoomIn") ? 1.5 : 1 / 1.5;
        setView((v) => zoomView(v, v.scale * factor));
      } else if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      } else if (slide?.videoUrl && video && hasDuration && (matches(e, "skipBack") || matches(e, "skipForward"))) {
        e.preventDefault();
        video.currentTime = Math.max(
          0,
          Math.min(video.duration, video.currentTime + (matches(e, "skipForward") ? 10 : -10)),
        );
      } else if (slide?.frameUrl && video && (matches(e, "frameBack") || matches(e, "frameForward"))) {
        e.preventDefault();
        video.pause();
        // 30 steps a second: the file's own frame rate isn't known here.
        video.currentTime = Math.max(0, video.currentTime + (matches(e, "frameForward") ? 1 : -1) / 30);
      } else if (matches(e, "next")) go((index + 1) % slides.length);
      else if (matches(e, "previous")) go((index - 1 + slides.length) % slides.length);
      else if (slide?.onRate && (matches(e, "rateClear") || RATE_ACTIONS.some((a) => matches(e, a)))) {
        const rating = RATE_ACTIONS.findIndex((a) => matches(e, a)) + 1;
        slide.onRate(rating === 0 || slide.rating === rating ? null : rating);
      } else if (slide?.onRate && RATE_NEXT_ACTIONS.some((a) => matches(e, a))) {
        const stars = RATE_NEXT_ACTIONS.findIndex((a) => matches(e, a));
        slide.onRate(stars === 0 ? null : stars);
        go(Math.min(index + 1, slides.length - 1));
      } else if (matches(e, "playPause") && slide?.videoUrl) {
        e.preventDefault();
        if (video) video.paused ? video.play() : video.pause();
      } else if (matches(e, "fullScreen") && canToggleFullscreenRef.current) {
        void toggleFullscreenRef.current();
      } else if (matches(e, "changeSpecies") && slide?.onReassign) setCorrecting(slide);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    index,
    slides,
    go,
    toggleFullscreenRef,
    canToggleFullscreenRef,
    correcting,
    editingCoordinates,
    editingAppearance,
    versionsRef,
    stepVersionRef,
    isTopLayer,
  ]);

  // The last photo can leave the list (an ID corrected in a filtered gallery): close rather than
  // leave an empty overlay holding the scroll lock. Keyed on the change, so it fires once.
  const slideMissing = slides.length === 0;
  const onCloseRef = useLatest(onClose);
  useEffect(() => {
    if (slideMissing) onCloseRef.current();
  }, [slideMissing, onCloseRef]);
  const decoded = useDecodedPhotos(slides, index);

  const slide = slides[index];
  if (!slide) return null;
  // Until the full photo has decoded, the copy the grid already drew holds its place.
  // Another version of the photo, switched to in the viewer: the file actions and names follow it.
  const otherVersion = activeVersion && activeVersion !== ownVersion && activeVersion.photoId ? activeVersion : null;
  const versionUrl = otherVersion ? `/api/photos/${otherVersion.photoId}/display` : null;
  const files = otherVersion ? [otherVersion.fileName] : (slide.info?.files ?? []);
  const placeholder = !versionUrl && slide.thumbUrl && !decoded.has(slide.url) ? sharpestShown(slide.thumbUrl) : null;

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
  const durationLabel = formatDuration(slide.info?.durationSeconds) || null;
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
    slide.onTagsChange ||
    slide.onRate ||
    !!slide.onAppearanceChange ||
    slide.coordinates?.lat != null ||
    !!slide.coordinates?.onChange
  );
  // A see-through light grey, to stand out on the black backdrop. The corner buttons are a fixed square with the
  // glyph centred, so each is a circle whatever the character's shape; the arrows are PhotoArrows.
  const iconButtonClass =
    "flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-body leading-none text-white transition-colors hover:bg-white/20";

  const videoIdle = !!slide.videoUrl && videoControlsIdle;
  // The controls and details step aside while a video plays untouched or the photo is zoomed in.
  const overlayFadeClass = videoIdle || view.scale > 1 ? "pointer-events-none opacity-0" : "opacity-100";
  // Outside fullscreen the photo shrinks to whatever the caption below leaves, rather than taking a
  // fixed share of the window and pushing past its top on a short one.
  const mediaClass = isFullscreen ? "h-full max-h-full w-full max-w-full" : "min-h-0 max-w-full";

  // On document.body, like Modal: an ancestor with a transform or filter (the species page's photo)
  // would otherwise size this fixed layer to itself instead of the window.
  return createPortal(
    <div
      data-overlay
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("lightbox.label")}
      tabIndex={-1}
      className={`fixed inset-0 z-50 bg-surround outline-none ${videoIdle ? "cursor-none" : ""}`}
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
        {/* The mac window's traffic lights get a drag strip of their own; the photo starts below it. */}
        <WindowTitleBar dark className="absolute inset-x-0 top-0" />
        <div
          className={`absolute right-4 top-4 z-10 flex items-center gap-2 transition-opacity duration-300 ${overlayFadeClass}`}
        >
          {versions.length > 1 && slide.captureId && (
            <Tooltip content={{ label: t("versions.manage"), shortcut: shortcutLabel("versionsShow") }}>
              {(tip) => (
                // raw-control: a lightbox overlay control, light on the dark backdrop.
                <button
                  {...tip}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openPhotoVersions(slide.captureId!, slide.onVersionsChange);
                  }}
                  // design-token: as the round controls beside it, a pill for its count
                  className="flex h-8 items-center gap-1.5 rounded-full bg-white/10 px-3 text-footnote text-white transition-colors hover:bg-white/20"
                >
                  <StackIcon className="h-3.5 w-3.5" />
                  {t("versions.badge", { count: versions.length })}
                </button>
              )}
            </Tooltip>
          )}
          {slide.download && (
            <Tooltip content={{ label: t("lightbox.download") }}>
              {(tip) => (
                // raw-control: a lightbox overlay control, light on the dark backdrop.
                <button
                  {...tip}
                  onClick={(e) => {
                    e.stopPropagation();
                    const { url, filename } = slide.download!;
                    void downloadWithToast(toast, url, filename);
                  }}
                  className={iconButtonClass}
                  aria-label={t("lightbox.download")}
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
            </Tooltip>
          )}
          {canToggleFullscreen && (
            <Tooltip
              content={{
                label: isFullscreen ? t("lightbox.exitFullscreen") : t("lightbox.enterFullscreen"),
                shortcut: shortcutLabel("fullScreen"),
              }}
            >
              {(tip) => (
                // raw-control: a lightbox overlay control, light on the dark backdrop.
                <button
                  {...tip}
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggleFullscreen();
                  }}
                  className={iconButtonClass}
                  aria-label={isFullscreen ? t("lightbox.exitFullscreen") : t("lightbox.enterFullscreen")}
                >
                  {isFullscreen ? "⤢" : "⛶"}
                </button>
              )}
            </Tooltip>
          )}
          <Tooltip content={{ label: t("lightbox.close"), shortcut: shortcutLabel("backToGrid") }}>
            {(tip) => (
              // raw-control: a lightbox overlay control, light on the dark backdrop.
              <button {...tip} onClick={handleClose} className={iconButtonClass} aria-label={t("lightbox.close")}>
                ×
              </button>
            )}
          </Tooltip>
        </div>

        {slides.length > 1 && (
          <PhotoArrows
            tone="dark"
            wide
            className={overlayFadeClass}
            onPrevious={() => go((index - 1 + slides.length) % slides.length)}
            onNext={() => go((index + 1) % slides.length)}
            previousLabel={t("lightbox.previous")}
            nextLabel={t("lightbox.next")}
          />
        )}

        {slide.audioUrl ? (
          <div className="flex w-full max-w-3xl flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
            <img src={slide.url} alt="" draggable={false} className="max-h-[60vh] w-full object-contain" />
            <audio key={slide.audioUrl} src={slide.audioUrl} controls className="w-full" />
          </div>
        ) : slide.videoUrl ? (
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
            onSeeked={(e) => setVideoTime(e.currentTarget.currentTime)}
            onPause={(e) => setVideoTime(e.currentTarget.currentTime)}
          />
        ) : slide.noPreview ? (
          <div
            className="flex h-64 w-64 flex-col items-center justify-center gap-2 rounded-panel bg-white/10 text-white/70"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-footnote font-medium uppercase tracking-wide">RAW</span>
            <span className="text-footnote">{t("lightbox.noPreview")}</span>
          </div>
        ) : imageFailed ? (
          <PhotoPlaceholder className="h-64 w-64" onClick={(e) => e.stopPropagation()} />
        ) : (
          // The frame takes the room the caption leaves, so paging never shifts the layout.
          <ZoomPane
            view={view}
            onViewChange={setView}
            onBackdropClick={() => void handleClose()}
            className={isFullscreen ? "h-full w-full" : "min-h-0 w-full flex-1"}
          >
            <img
              src={versionUrl ?? placeholder ?? slide.url}
              alt=""
              draggable={false}
              className="h-full w-full object-contain"
              onError={() => {
                if (!placeholder) setImageFailed(true);
              }}
            />
          </ZoomPane>
        )}

        {hasCaptionBand && (isFullscreen ? !!slide.videoUrl : true) && (
          <div
            className={
              isFullscreen
                ? `absolute inset-x-0 bottom-12 z-10 bg-gradient-to-t from-black/70 to-transparent px-4 pb-2 pt-8 text-center text-callout text-white/70 transition-opacity duration-300 ${overlayFadeClass}`
                : `mt-3 w-full max-w-3xl shrink-0 text-center text-callout text-white/70 transition-opacity duration-300 ${overlayFadeClass}`
            }
            onClick={(e) => e.stopPropagation()}
          >
            {/* Ratings only exist on your own photos, so reference photos skip the tip. */}
            <Tip id="viewer-keys" dark takeOver when={!!slide.onRate} className="mb-2 text-left" />
            {/* Kept to a few lines so the photo above gets the height on a small window. */}
            {(slide.caption ||
              durationLabel ||
              slide.speciesId ||
              slide.similarHref ||
              slide.onReassign ||
              slide.frameUrl ||
              (slide.captureId && editors[0])) && (
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
                      {t("lightbox.viewSpecies")}
                    </Link>
                  </>
                )}
                {slide.similarHref && (
                  <>
                    <span className="text-white/40"> · </span>
                    {/* The group opens behind the viewer, so the viewer closes. */}
                    <Link
                      to={slide.similarHref}
                      onClick={() => void handleClose()}
                      className="text-white/70 underline hover:text-white"
                    >
                      {t("lightbox.similar")}
                    </Link>
                  </>
                )}
                {slide.onReassign && (
                  <>
                    <span className="text-white/40"> · </span>
                    {/* raw-control: a link in the caption, light on the dark backdrop. */}
                    <button
                      type="button"
                      onClick={() => setCorrecting(slide)}
                      className="text-white/70 underline hover:text-white"
                    >
                      {t("captureEdit.reassign.title")}
                    </button>
                  </>
                )}
                {slide.frameUrl && slide.videoUrl && (
                  <>
                    {/* design-token: caption text on the dark surround, as the links above */}
                    <span className="text-white/40"> · </span>
                    {/* raw-control: a link in the caption, light on the dark backdrop. design-token: as above */}
                    <button
                      type="button"
                      onClick={() => void saveFrame(slide.frameUrl!, slide.onFrameSaved)}
                      // design-token: as the links above
                      className="text-white/70 underline hover:text-white"
                    >
                      {t("lightbox.saveFrame", { time: frameTimeLabel(videoTime) })}
                    </button>
                  </>
                )}
                {checklist && (
                  <>
                    {/* design-token: caption text on the dark surround, as the links above */}
                    <span className="text-white/40"> · </span>
                    {/* raw-control: a link in the caption, light on the dark backdrop. design-token: as above */}
                    <button
                      type="button"
                      onClick={() => openExternal(checklist.url)}
                      // design-token: as the links above
                      className="text-white/70 underline hover:text-white"
                    >
                      {t("lightbox.ebirdChecklist")}
                    </button>
                  </>
                )}
                {slide.captureId && editors[0] && (
                  <>
                    {/* design-token: caption text on the dark surround, as the links above */}
                    <span className="text-white/40"> · </span>
                    {/* raw-control: a link in the caption, light on the dark backdrop. design-token: as above */}
                    <button
                      type="button"
                      onClick={() =>
                        openIn(
                          editors[0],
                          otherVersion?.photoId
                            ? { photoIds: [otherVersion.photoId] }
                            : { captureIds: [slide.captureId!] },
                        )
                      }
                      // design-token: as the links above
                      className="text-white/70 underline hover:text-white"
                    >
                      {t("openIn.item", { name: editors[0].name })}
                    </button>
                  </>
                )}
              </p>
            )}
            {slide.onRate && (
              <div className="mt-1 flex justify-center">
                <StarRating rating={slide.rating ?? null} onRate={slide.onRate} size="text-body" />
              </div>
            )}
            {(slide.onAppearanceChange || slide.appearance) && (
              <div className="mt-1 flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
                <AppearanceBadges dark appearance={slide.appearance} className="justify-center" />
                {slide.onAppearanceChange && slide.captureId && (
                  // raw-control: a link in the caption, light on the dark backdrop. design-token: as the links above
                  <button
                    type="button"
                    onClick={() => setEditingAppearance(slide)}
                    // design-token: as the links above
                    className="text-footnote text-white/70 underline hover:text-white"
                  >
                    {Object.values(slide.appearance ?? {}).some(Boolean) ? t("appearance.edit") : t("appearance.add")}
                  </button>
                )}
              </div>
            )}
            {(cameraLine || takenLabel || slide.info?.cull) && (
              <p className="mt-0.5 text-footnote text-white/50">
                {[cameraLine, takenLabel, slide.info?.cull].filter(Boolean).join(" · ")}
              </p>
            )}
            {files.length > 0 && (
              // Selectable, with the full stored location on hover, for finding the file yourself.
              <p className="mt-0.5 select-text text-footnote text-white/50" onClick={(e) => e.stopPropagation()}>
                {files.map((ref, i) => (
                  <span key={ref} title={ref}>
                    {i > 0 && " · "}
                    {fileNameOf(ref)}
                  </span>
                ))}
              </p>
            )}
            {versions.length > 1 && groupCaptureId && activeVersion && (
              <VersionStrip
                versions={versions}
                groupCaptureId={groupCaptureId}
                activeId={activeVersion.captureId}
                onSelect={showVersion}
                onChange={slide.onVersionsChange}
              />
            )}
            {slide.coordinates && (slide.coordinates.lat != null || slide.coordinates.onChange) && (
              <p className="mt-0.5 text-footnote text-white/50">
                {slide.coordinates.lat != null && slide.coordinates.lon != null && (
                  <span className="select-text">{formatCoordinates(slide.coordinates.lat, slide.coordinates.lon)}</span>
                )}
                {slide.coordinates.onChange && slide.captureId && (
                  <>
                    {slide.coordinates.lat != null && <span className="text-white/40"> · </span>}
                    {/* raw-control: a link in the caption, light on the dark backdrop. */}
                    <button
                      type="button"
                      onClick={() => setEditingCoordinates(slide)}
                      className="text-white/70 underline hover:text-white"
                    >
                      {slide.coordinates.lat != null ? t("coordinates.edit") : t("coordinates.add")}
                    </button>
                  </>
                )}
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
                  <span className="text-footnote text-white/40">
                    {formatNumber(index + 1)} / {formatNumber(Math.max(total ?? 0, slides.length))}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {/* Clicks inside the dialog would otherwise reach the viewer's click-to-close. */}
      {correcting?.onReassign && (
        <div onClick={(e) => e.stopPropagation()}>
          <CaptureEditModal
            edit="reassign"
            capture={{ captureId: correcting.captureId, tags: [] }}
            tagOptions={[]}
            onTagsChange={() => {}}
            onReassign={correcting.onReassign}
            onClose={() => setCorrecting(null)}
          />
        </div>
      )}
      {editingAppearance?.onAppearanceChange && editingAppearance.captureId && (
        <div onClick={(e) => e.stopPropagation()}>
          <AppearanceModal
            captureIds={[editingAppearance.captureId]}
            initial={editingAppearance.appearance ?? NO_APPEARANCE}
            morphOptions={morphOptions}
            onSaved={editingAppearance.onAppearanceChange}
            onClose={() => setEditingAppearance(null)}
          />
        </div>
      )}
      {editingCoordinates?.coordinates?.onChange && editingCoordinates.captureId && (
        <div onClick={(e) => e.stopPropagation()}>
          <CoordinatesModal
            captureIds={[editingCoordinates.captureId]}
            lat={editingCoordinates.coordinates.lat}
            lon={editingCoordinates.coordinates.lon}
            suggestRegion={!editingCoordinates.coordinates.hasRegion}
            onSaved={editingCoordinates.coordinates.onChange}
            onClose={() => setEditingCoordinates(null)}
          />
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Lets any thumbnail open full size: `viewer.open(slides, index)` from its click, and render
 *  `viewer.node` once anywhere in the component (the viewer portals to the page's top). */
export function useLightbox(): {
  open: (slides: LightboxSlide[], index?: number) => void;
  node: ReactNode;
} {
  const [shown, setShown] = useState<{ slides: LightboxSlide[]; index: number } | null>(null);
  const open = useCallback((slides: LightboxSlide[], index = 0) => {
    if (slides.length > 0) setShown({ slides, index: Math.min(Math.max(index, 0), slides.length - 1) });
  }, []);
  const node = shown ? (
    <Lightbox
      slides={shown.slides}
      index={shown.index}
      onIndexChange={(index) => setShown((s) => s && { ...s, index })}
      onClose={() => setShown(null)}
    />
  ) : null;
  return { open, node };
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
