import { useMemo, useState } from "react";
import Lightbox, { type LightboxSlide } from "../../components/Lightbox";
import PhotoPlaceholder from "../../components/PhotoPlaceholder";
import { fullSizeUrl, type SpeciesDetail } from "./types";

function focal(value: number | string | null): number | null {
  return value == null ? null : Number(value);
}

// Your cover photo first (or the catalog reference photo), then the reference gallery as alternates.
function buildHeroSlides(detail: SpeciesDetail): LightboxSlide[] {
  const { species, userSpecies, referencePhotos, captures } = detail;
  const slides: LightboxSlide[] = [];

  const coverCapture = captures.find((c) => c.photo_id === userSpecies?.cover_photo_id);
  const coverUrl = userSpecies?.cover_photo_id && coverCapture ? fullSizeUrl(coverCapture) : null;
  if (coverUrl) {
    slides.push({ url: coverUrl, caption: "Your photo" });
  } else if (species.reference_photo_url) {
    slides.push({
      url: species.reference_photo_url,
      caption: species.reference_credit,
      focalX: focal(species.reference_focal_x),
      focalY: focal(species.reference_focal_y),
    });
  }

  for (const p of referencePhotos) {
    // A row can exist without a file behind it (a failed fetch).
    if (!p.photo_url) continue;
    if (p.photo_url === species.reference_photo_url && !coverUrl) continue;
    slides.push({ url: p.photo_url, caption: p.credit, focalX: focal(p.focal_x), focalY: focal(p.focal_y) });
  }
  return slides;
}

export default function SpeciesHero({ detail }: { detail: SpeciesDetail }) {
  const slides = useMemo(() => buildHeroSlides(detail), [detail]);
  const [rawIndex, setRawIndex] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // A different set of slides starts over at the first.
  const [slideCount, setSlideCount] = useState(slides.length);
  if (slideCount !== slides.length) {
    setSlideCount(slides.length);
    setRawIndex(0);
  }
  // The render that notices the new count still has the old index, so clamp it.
  const index = slides.length === 0 ? 0 : Math.min(rawIndex, slides.length - 1);
  const slide = slides[index];
  // Which slide failed to load, so moving to another one tries again.
  const slideKey = `${index}|${slide?.url ?? ""}`;
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const failed = failedKey === slideKey;

  const name = detail.species.common_name ?? detail.species.scientific_name;

  if (!slide || failed) return <PhotoPlaceholder className="aspect-[16/9]" />;

  return (
    <>
      <figure className="relative">
        <img
          src={slide.url}
          alt={name}
          onClick={() => setLightboxIndex(index)}
          className="aspect-[16/9] w-full cursor-pointer rounded-lg object-cover"
          style={{ objectPosition: `${slide.focalX ?? 50}% ${slide.focalY ?? 50}%` }}
          onError={() => setFailedKey(slideKey)}
        />
        {slides.length > 1 && (
          <>
            <button
              onClick={() => setRawIndex((index - 1 + slides.length) % slides.length)}
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/30 px-2.5 py-1 text-lg text-white hover:bg-black/50"
              aria-label="Previous reference photo"
            >
              ‹
            </button>
            <button
              onClick={() => setRawIndex((index + 1) % slides.length)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/30 px-2.5 py-1 text-lg text-white hover:bg-black/50"
              aria-label="Next reference photo"
            >
              ›
            </button>
            <span className="absolute bottom-[28px] right-2 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white">
              {index + 1} / {slides.length}
            </span>
          </>
        )}
        {slide.caption && <figcaption className="mt-1 text-[11px] text-muted">{slide.caption}</figcaption>}
      </figure>
      {lightboxIndex != null && (
        <Lightbox
          slides={slides}
          index={Math.min(lightboxIndex, slides.length - 1)}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}
