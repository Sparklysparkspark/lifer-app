import { useState } from "react";
import { api } from "../../api/client";
import Lightbox, { type LightboxSlide } from "../Lightbox";

/** Every reference photo of a suggested species, for comparing against the photo under review.
 * `open` fetches them; `lightbox` renders the viewer while one is open. */
export function useSpeciesGallery() {
  const [gallery, setGallery] = useState<{ slides: LightboxSlide[]; index: number } | null>(null);

  async function open(speciesId: string, label: string) {
    const caption = (credit: string | null) => (credit ? `${label} · ${credit}` : label);
    const single = [{ url: `/api/species/${speciesId}/reference-photo/display`, caption: caption(null) }];
    try {
      const res = await api.get<{ photos: Array<{ url: string; credit: string | null }> }>(`/species/${speciesId}/reference-photos`);
      setGallery({ slides: res.photos.length > 0 ? res.photos.map((p) => ({ url: p.url, caption: caption(p.credit) })) : single, index: 0 });
    } catch {
      // Fall back to the single reference photo the card already shows.
      setGallery({ slides: single, index: 0 });
    }
  }

  const lightbox = gallery && (
    <Lightbox
      slides={gallery.slides}
      index={gallery.index}
      onIndexChange={(index) => setGallery({ ...gallery, index })}
      onClose={() => setGallery(null)}
    />
  );

  return { open, lightbox };
}
