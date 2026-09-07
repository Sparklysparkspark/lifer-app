import { useEffect, useState, type CSSProperties } from "react";
import PhotoPlaceholder from "./PhotoPlaceholder";

// Renders a small/fast thumbnail first for a quick initial paint (especially useful on a
// page with many photos), then preloads the full-resolution derivative in the background and
// swaps to it the moment it's ready. Shared between SpeciesDetailPage's own-photo grid and
// SpeciesCard's collection-grid cover photo.
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
  const [loadedSrc, setLoadedSrc] = useState(thumbSrc);
  // A record pointing at a photo whose file has since moved or been deleted (a storage
  // migration, manual cleanup) would otherwise show the browser's own broken-image icon —
  // this falls back to the same placeholder shown when there's no photo at all, so a missing
  // file reads as "nothing here" rather than as an error.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    setLoadedSrc(thumbSrc);
    const img = new Image();
    img.src = fullSrc;
    img.onload = () => setLoadedSrc(fullSrc);
    // No cleanup needed to "cancel" a stale load — onload firing after this photo's props
    // changed would just set loadedSrc to a URL no longer being displayed for, harmless.
  }, [thumbSrc, fullSrc]);

  if (failed) return <PhotoPlaceholder className={className} />;

  return (
    <img
      src={loadedSrc}
      alt={alt}
      onClick={onClick}
      // bg-surface-muted (the same "empty" tone PhotoPlaceholder uses) matters here: a browser
      // paints an <img>'s own background color immediately, before the image itself has loaded
      // over the network — without it, every tile in a freshly opened grid is blank/invisible
      // until its own thumbnail finishes loading, so only whichever photos happen to already be
      // browser-cached appear right away and the rest of the grid reads as a jarring "flash of
      // near-empty" for however long the rest take to arrive. The color is fully covered once
      // the image paints, so this is invisible in the already-loaded steady state.
      className={`bg-surface-muted ${className ?? ""}`}
      style={style}
      onError={() => setFailed(true)}
    />
  );
}
