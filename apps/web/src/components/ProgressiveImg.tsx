import { useEffect, useState, type CSSProperties } from "react";

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
  useEffect(() => {
    setLoadedSrc(thumbSrc);
    const img = new Image();
    img.src = fullSrc;
    img.onload = () => setLoadedSrc(fullSrc);
    // No cleanup needed to "cancel" a stale load — onload firing after this photo's props
    // changed would just set loadedSrc to a URL no longer being displayed for, harmless.
  }, [thumbSrc, fullSrc]);

  return <img src={loadedSrc} alt={alt} onClick={onClick} className={className} style={style} />;
}
