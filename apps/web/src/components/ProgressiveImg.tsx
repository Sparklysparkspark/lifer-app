import { useEffect, useRef, useState, type CSSProperties } from "react";
import PhotoPlaceholder from "./PhotoPlaceholder";

// Grid photos: a small thumbnail first for a quick paint, then a sharper version only if the tile
// is big enough to need one. Shared by the species page's photo grid, collection cards, the
// gallery and trips.
//
// Two things keep a big library fast:
//   - Nothing loads until the photo is within about a screen of being visible. Before, opening
//     the gallery downloaded every photo in the library at once (127 MB for 2,000 photos).
//   - The upgrade matches the tile's real size on screen. Before, every tile swapped to the
//     2,560px display image even at 250px wide. A photo of your own has a 1,024px "medium"
//     copy for grid-sized tiles; the display image is only fetched for a tile wider than that.
const THUMB_WIDTH = 400;
const MEDIUM_WIDTH = 1024;
const NEAR_VIEWPORT = "800px";
// A failed load is tried again after these delays before showing the placeholder. One failure
// (the server busy with an import, restarting, or rebuilding a missing thumbnail) used to leave
// the card blank until the page was reloaded.
const RETRY_DELAYS_MS = [2_000, 10_000];

function withRetry(src: string, attempt: number): string {
  if (attempt === 0) return src;
  return `${src}${src.includes("?") ? "&" : "?"}retry=${attempt}`;
}

function mediumSrcFor(thumbSrc: string): string | null {
  // Only your own photos (/api/photos/:id/thumb) have a medium copy; shared-album and reference
  // photos go straight from thumbnail to display.
  return /^\/api\/photos\/[^/]+\/thumb(\?.*)?$/.test(thumbSrc) ? thumbSrc.replace("/thumb", "/medium") : null;
}

export default function ProgressiveImg({
  thumbSrc,
  fullSrc,
  alt,
  onClick,
  className,
  style,
}: {
  thumbSrc: string;
  fullSrc: string;
  alt: string;
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [near, setNear] = useState(false);
  const [loadedSrc, setLoadedSrc] = useState(thumbSrc);
  // A record pointing at a photo whose file has since moved or been deleted would otherwise show
  // the browser's broken-image icon; the placeholder reads as "nothing here" instead.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);

  useEffect(() => {
    // The box the photo is shown in, not the image itself: an image not loaded yet has no size,
    // and a cropped one is positioned with its corner outside that box, which clips it away
    // entirely. The browser then never reported it as on screen, so a cropped card stayed blank.
    const el = imgRef.current?.parentElement ?? imgRef.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: NEAR_VIEWPORT },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    setFailed(false);
    setAttempt(0);
    setLoadedSrc(thumbSrc);
    if (!near) return;
    const el = imgRef.current;
    const shownWidth = (el?.getBoundingClientRect().width ?? 0) * (window.devicePixelRatio || 1);
    // The thumbnail is enough for a small tile (a little upscaling isn't visible).
    if (shownWidth > 0 && shownWidth <= THUMB_WIDTH * 1.25) return;
    const medium = mediumSrcFor(thumbSrc);
    const target = medium && (shownWidth === 0 || shownWidth <= MEDIUM_WIDTH * 1.15) ? medium : fullSrc;
    if (target === thumbSrc) return;
    let cancelled = false;
    const img = new Image();
    img.src = target;
    img.onload = () => {
      if (!cancelled) setLoadedSrc(target);
    };
    return () => {
      cancelled = true;
    };
  }, [thumbSrc, fullSrc, near]);

  if (failed) return <PhotoPlaceholder className={className} />;

  return (
    <img
      ref={imgRef}
      // No src until the photo is near the screen, so a long grid doesn't download everything.
      src={near ? withRetry(loadedSrc, attempt) : undefined}
      alt={alt}
      onClick={onClick}
      decoding="async"
      // bg-surface-muted (the same "empty" tone PhotoPlaceholder uses) is painted before the
      // image arrives, so a freshly opened grid shows tiles instead of a flash of blank space.
      className={`bg-surface-muted ${className ?? ""}`}
      style={style}
      onError={() => {
        // A missing medium copy falls back to the display image rather than a placeholder.
        if (loadedSrc !== fullSrc && loadedSrc !== thumbSrc) setLoadedSrc(fullSrc);
        else if (attempt < RETRY_DELAYS_MS.length) {
          if (retryTimer.current) clearTimeout(retryTimer.current);
          retryTimer.current = setTimeout(() => setAttempt((a) => a + 1), RETRY_DELAYS_MS[attempt]);
        } else setFailed(true);
      }}
    />
  );
}
