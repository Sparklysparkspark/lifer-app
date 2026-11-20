// The picture preview behind a card's magnifier, Space and Enter: the shared Lightbox the Gallery
// and the map use, over the card's photos.
import { useState } from "react";
import Lightbox, { type LightboxSlide } from "../../components/Lightbox";

/** A species card previews at most this many of its photos, one from each sighting or observation first. */
const SPECIES_PREVIEW_CAP = 500;

export type PreviewPhoto =
  | { kind: "local"; photoId: string }
  /** Not on this computer: iNaturalist's own preview, through Lifer. */
  | { kind: "inat"; observationId: string; photoId: string };

export function previewSlides(photos: PreviewPhoto[], caption: string): LightboxSlide[] {
  return photos
    .slice(0, SPECIES_PREVIEW_CAP)
    .map((p) =>
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
  return { open: (slides: LightboxSlide[]) => setState({ slides, index: 0 }), isOpen: state !== null, node };
}
