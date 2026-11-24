// The picture preview behind a card's magnifier, Space and Enter: the shared Lightbox the Gallery
// and the map use, over the card's photos.
import { useState } from "react";
import Lightbox, { type LightboxSlide } from "../../components/Lightbox";

export type PreviewPhoto =
  | { kind: "local"; photoId: string }
  /** Not on this computer: iNaturalist's own preview, through Lifer. */
  | { kind: "inat"; observationId: string; photoId: string };

/** Every photo, so the counter agrees with the card: the viewer only draws the one on screen. */
export function previewSlides(photos: PreviewPhoto[], caption: string): LightboxSlide[] {
  return photos.map((p) =>
    p.kind === "local"
      ? { url: `/api/photos/${p.photoId}/display`, caption }
      : { url: `/api/inaturalist/observations/${p.observationId}/photos/${p.photoId}`, caption },
  );
}

/** Opens the Lightbox on a list of slides; `node` renders it. */
export function usePhotoPreview() {
  const [state, setState] = useState<{ slides: LightboxSlide[]; index: number } | null>(null);
  const node = state && state.slides.length > 0 && (
    <Lightbox
      slides={state.slides}
      index={state.index}
      onIndexChange={(index) => setState((prev) => (prev ? { ...prev, index } : prev))}
      onClose={() => setState(null)}
    />
  );
  // Past the end (a photo with no picture yet) falls back to the last slide.
  const open = (slides: LightboxSlide[], index = 0) =>
    setState({ slides, index: Math.max(0, Math.min(index, slides.length - 1)) });
  return { open, isOpen: state !== null, node };
}
