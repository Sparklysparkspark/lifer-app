import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import Button from "./Button";
import InfoTip from "./InfoTip";
import ProgressiveImg from "./ProgressiveImg";
import StarRating from "./StarRating";
import ZoomPane from "./ZoomPane";
import WindowTitleBar from "./WindowTitleBar";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useLatest } from "../hooks/useLatest";
import { isTypingTarget } from "../hooks/useKeyboardShortcuts";
import { ignore } from "../lib/ignore";
import { markDragBlocked } from "../lib/modalDragBlock";
import { matches, type KeyAction } from "../lib/keymap";
import { formatDate } from "../lib/format";
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

/** One photo in a comparison, mapped by the page from its own row shape. */
export interface ComparePhoto {
  captureId: string;
  photoId: string;
  /** The species name, already in the user's naming style. */
  name: string;
  takenAt?: string | null;
  /** Camera, lens and exposure, one line. */
  detail?: string | null;
  rating: number | null;
  /** Its species' featured photo. */
  isFeatured?: boolean | null;
}

// Below this the photos don't fit side by side, so the view asks for one pick at a time instead.
const NARROW_QUERY = "(max-width: 639px)";

function useNarrow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia?.(NARROW_QUERY);
      mq?.addEventListener("change", onChange);
      return () => mq?.removeEventListener("change", onChange);
    },
    () => window.matchMedia?.(NARROW_QUERY).matches ?? false,
  );
}

function when(takenAt: string | null | undefined): string {
  return [formatDate(takenAt, "medium"), formatDate(takenAt, "timeSeconds")].filter(Boolean).join(" · ");
}

// Two to four photos side by side with one zoom and pan for all, so a burst's frames can be told
// apart. The keyboard rates or features the focused photo; nothing here
// deletes or hides. On a phone it becomes a pick-the-better-one run instead.
export default function CompareView({
  photos,
  onClose,
  onRate,
  onFeature,
  onSetAlbumCover,
  albumCoverPhotoId,
}: {
  photos: ComparePhoto[];
  onClose: () => void;
  onRate: (captureId: string, rating: number | null) => void;
  /** Makes the photo its species' featured photo. */
  onFeature?: (photo: ComparePhoto) => void;
  /** In an album: makes the photo its cover. */
  onSetAlbumCover?: (photo: ComparePhoto) => void;
  albumCoverPhotoId?: string | null;
}) {
  const { t } = useTranslation();
  const narrow = useNarrow();
  const [focused, setFocused] = useState(0);
  const [view, setView] = useState<View>(FIT);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
  useEscapeToClose(onClose);
  // The title-bar drag strip would otherwise swallow clicks on the header.
  useEffect(() => {
    markDragBlocked(true);
    return () => markDragBlocked(false);
  }, []);

  const count = photos.length;
  const current = photos[Math.min(focused, count - 1)];
  const latest = useLatest({ photos, current, count, onRate, onFeature, onSetAlbumCover, narrow });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target) || e.defaultPrevented || e.altKey) return;
      const { current: photo, count: n, onRate: rate, onFeature: feature } = latest.current;
      if (matches(e, "zoomFit")) {
        setView(FIT);
      } else if (matches(e, "zoomIn") || matches(e, "zoomOut")) {
        setView((v) => zoomView(v, v.scale * (matches(e, "zoomIn") ? 1.5 : 1 / 1.5)));
      } else if (e.metaKey || e.ctrlKey || !photo) {
        return;
      } else if (matches(e, "next")) setFocused((i) => (i + 1) % n);
      else if (matches(e, "previous")) setFocused((i) => (i - 1 + n) % n);
      else if (matches(e, "rateClear")) rate(photo.captureId, null);
      else if (RATE_ACTIONS.some((a) => matches(e, a))) {
        const stars = RATE_ACTIONS.findIndex((a) => matches(e, a)) + 1;
        rate(photo.captureId, photo.rating === stars ? null : stars);
      } else if (RATE_NEXT_ACTIONS.some((a) => matches(e, a))) {
        const stars = RATE_NEXT_ACTIONS.findIndex((a) => matches(e, a));
        rate(photo.captureId, stars === 0 ? null : stars);
        setFocused((i) => Math.min(i + 1, n - 1));
      } else if (matches(e, "feature") && feature && !photo.isFeatured) feature(photo);
      else if (matches(e, "fullScreen")) {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void dialogRef.current?.requestFullscreen?.().catch(ignore("Couldn't change fullscreen"));
      } else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [latest]);

  if (count === 0) return null;
  const title = narrow ? t("compare.pickTitle") : t("compare.title", { count });
  // Four go two by two: a row of four leaves landscape photos a thin strip each.
  const columns = count === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";

  return createPortal(
    <div
      ref={dialogRef}
      data-overlay
      role="dialog"
      aria-modal="true"
      aria-label={t("compare.label", { count })}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-surround outline-none"
      data-testid="compare-view"
    >
      <WindowTitleBar title={title} />
      <header className="flex items-center gap-3 border-b border-line bg-surface px-page py-2">
        {/* The help sits by the title, as on every page; the title itself moves up on the mac. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2 className="window-title-elsewhere min-w-0 truncate text-headline text-ink">{title}</h2>
          {!narrow && (
            <InfoTip
              paragraphs={[
                t("compare.help.zoom"),
                t("compare.help.keys"),
                ...(onFeature ? [t("compare.help.feature")] : []),
              ]}
            />
          )}
        </div>
        {!narrow && view.scale > 1 && (
          <Button variant="secondary" size="sm" onClick={() => setView(FIT)}>
            {t("compare.fit")}
          </Button>
        )}
        {/* On a phone the kept photo's own action is the main one. */}
        <Button size="sm" variant={narrow ? "secondary" : "primary"} onClick={onClose}>
          {t("common.done")}
        </Button>
      </header>
      {narrow ? (
        <PickBest
          photos={photos}
          onRate={onRate}
          onFeature={onFeature}
          onSetAlbumCover={onSetAlbumCover}
          albumCoverPhotoId={albumCoverPhotoId}
        />
      ) : (
        <div className={`grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-3 p-3 ${columns}`}>
          {photos.map((photo, i) => (
            <figure
              key={photo.captureId}
              className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-panel border bg-surface ${
                i === focused ? "border-accent ring-2 ring-accent" : "border-line"
              }`}
              data-focused={i === focused || undefined}
            >
              <ZoomPane
                view={view}
                onViewChange={setView}
                onMouseDown={() => setFocused(i)}
                className="min-h-0 flex-1 bg-surface-muted"
              >
                <ProgressiveImg
                  thumbSrc={`/api/photos/${photo.photoId}/thumb`}
                  fullSrc={`/api/photos/${photo.photoId}/display`}
                  alt={photo.name}
                  className="h-full w-full object-contain"
                />
              </ZoomPane>
              <PhotoFacts
                photo={photo}
                onRate={onRate}
                isCover={!!albumCoverPhotoId && albumCoverPhotoId === photo.photoId}
              />
            </figure>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

function PhotoFacts({
  photo,
  onRate,
  isCover,
}: {
  photo: ComparePhoto;
  onRate: (captureId: string, rating: number | null) => void;
  isCover: boolean;
}) {
  const { t } = useTranslation();
  const badges = [photo.isFeatured && t("compare.featured"), isCover && t("compare.albumCover")].filter(Boolean);
  return (
    <figcaption className="shrink-0 space-y-0.5 border-t border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-callout font-medium text-ink" title={photo.name}>
          {photo.name}
        </p>
        <StarRating rating={photo.rating} onRate={(r) => onRate(photo.captureId, r)} />
      </div>
      <p className="truncate text-footnote tabular-nums text-muted">
        {[when(photo.takenAt), ...badges].filter(Boolean).join(" · ") || " "}
      </p>
      {photo.detail && (
        <p className="truncate text-footnote text-muted" title={photo.detail}>
          {photo.detail}
        </p>
      )}
    </figcaption>
  );
}

// The narrow layout: two photos stacked, the better one stays and meets the next, until one is left.
function PickBest({
  photos,
  onRate,
  onFeature,
  onSetAlbumCover,
  albumCoverPhotoId,
}: {
  photos: ComparePhoto[];
  onRate: (captureId: string, rating: number | null) => void;
  onFeature?: (photo: ComparePhoto) => void;
  onSetAlbumCover?: (photo: ComparePhoto) => void;
  albumCoverPhotoId?: string | null;
}) {
  const { t } = useTranslation();
  const [kept, setKept] = useState(0);
  const [next, setNext] = useState(1);
  const done = next >= photos.length;
  const best = photos[Math.min(kept, photos.length - 1)];

  if (done) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <p className="text-callout text-muted">{t("compare.pickDone")}</p>
        <div className="min-h-64 flex-1 overflow-hidden rounded-panel border border-line bg-surface-muted">
          <ProgressiveImg
            thumbSrc={`/api/photos/${best.photoId}/thumb`}
            fullSrc={`/api/photos/${best.photoId}/display`}
            alt={best.name}
            className="h-full w-full object-contain"
          />
        </div>
        <PhotoFacts photo={best} onRate={onRate} isCover={albumCoverPhotoId === best.photoId} />
        <div className="flex flex-wrap gap-2">
          {onFeature && (
            <Button onClick={() => onFeature(best)} disabled={!!best.isFeatured}>
              {best.isFeatured ? t("compare.featured") : t("photoMenu.feature")}
            </Button>
          )}
          {onSetAlbumCover && (
            <Button variant={onFeature ? "secondary" : "primary"} onClick={() => onSetAlbumCover(best)}>
              {t("compare.makeCover")}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              setKept(0);
              setNext(1);
            }}
          >
            {t("compare.pickAgain")}
          </Button>
        </div>
      </div>
    );
  }

  const pair = [best, photos[next]];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <p className="text-callout text-muted">{t("compare.pickPrompt", { step: next, total: photos.length - 1 })}</p>
      {pair.map((photo) => (
        // raw-control: the whole photo is the choice, like a photo tile.
        <button
          key={photo.captureId}
          type="button"
          aria-label={t("compare.keep", { position: photo === best ? "top" : "bottom" })}
          onClick={() => {
            if (photo !== best) setKept(next);
            setNext((n) => n + 1);
          }}
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border border-line bg-surface text-left transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ProgressiveImg
            thumbSrc={`/api/photos/${photo.photoId}/thumb`}
            fullSrc={`/api/photos/${photo.photoId}/display`}
            alt=""
            className="min-h-0 w-full flex-1 bg-surface-muted object-contain"
          />
          <span className="truncate px-3 py-2 text-footnote tabular-nums text-muted">
            {when(photo.takenAt) || photo.name}
          </span>
        </button>
      ))}
    </div>
  );
}
