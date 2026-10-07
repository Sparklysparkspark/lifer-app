import { useEffect, useRef, useState, type CSSProperties } from "react";
import PhotoPlaceholder from "./PhotoPlaceholder";

// Grid photo: thumbnail first, then a sharper copy sized to the tile. Nothing loads until the tile
// is about a screen away, and the 1,024px "medium" copy is used before the full display image.
const THUMB_WIDTH = 400;
const MEDIUM_WIDTH = 1024;
const NEAR_VIEWPORT = "800px";
// Retries before the placeholder, since a busy or restarting server often fails one request.
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
  // Without IntersectionObserver there's no way to wait, so everything counts as near.
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const [loadedSrc, setLoadedSrc] = useState(thumbSrc);
  // A record pointing at a photo whose file has since moved or been deleted would otherwise show
  // the browser's broken-image icon; the placeholder reads as "nothing here" instead.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );

  useEffect(() => {
    // Observes the containing box: an unloaded or cropped image may never intersect by itself.
    const el = imgRef.current?.parentElement ?? imgRef.current;
    if (!el || near) return;
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

  // A new photo (or the tile coming near) starts over from its thumbnail.
  const sourceKey = `${thumbSrc}|${fullSrc}|${near}`;
  const [shownKey, setShownKey] = useState(sourceKey);
  if (shownKey !== sourceKey) {
    setShownKey(sourceKey);
    setFailed(false);
    setAttempt(0);
    setLoadedSrc(thumbSrc);
  }

  useEffect(() => {
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
      // Placeholder tone behind the image so an unloaded grid still shows tiles.
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
