import ProgressiveImg from "./ProgressiveImg";
import PhotoPlaceholder from "./PhotoPlaceholder";
import { cropToImageStyle } from "../lib/crop";
import type { QuadSlot } from "@lifer/shared";

// Shared by Album and Trip cards/detail pages — both have the same two cover styles: a single
// cropped photo (the original, still-default behavior), or a 2x2 grid of the 4 most-recently
// added/taken photos ("quad"), an alternative for someone who'd rather show a taste of what's
// inside than commit to one photo as the "face" of the collection.
export default function CoverImage({
  layout,
  coverPhotoUrl,
  cropX,
  cropY,
  cropSize,
  quadSlots,
  alt,
}: {
  layout: "single" | "quad";
  /** Thumb-size URL, same convention TripSummary/Album already use elsewhere. */
  coverPhotoUrl: string | null;
  cropX: number | null;
  cropY: number | null;
  cropSize: number | null;
  /** Always 4 entries; null tiles render as an empty placeholder square (a brand-new
   *  collection with fewer than 4 photos yet). Trips doesn't support per-slot crops yet, so
   *  its own synthesized slots always carry null crops (plain object-fit: cover). */
  quadSlots: Array<QuadSlot | null>;
  alt: string;
}) {
  if (layout === "quad" && quadSlots.some((s) => s != null)) {
    return (
      <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-0.5">
        {Array.from({ length: 4 }, (_, i) => quadSlots[i] ?? null).map((slot, i) =>
          slot ? (
            <div key={slot.photoId} className="relative h-full w-full overflow-hidden">
              <ProgressiveImg
                thumbSrc={`/api/photos/${slot.photoId}/thumb`}
                fullSrc={`/api/photos/${slot.photoId}/thumb`}
                alt=""
                className="h-full w-full"
                style={cropToImageStyle(slot.cropX, slot.cropY, slot.cropSize)}
              />
            </div>
          ) : (
            <div key={i} className="bg-surface-muted" />
          ),
        )}
      </div>
    );
  }
  if (coverPhotoUrl) {
    return (
      <ProgressiveImg
        thumbSrc={coverPhotoUrl}
        fullSrc={coverPhotoUrl.replace(/\/thumb$/, "/display")}
        alt={alt}
        className="h-full w-full"
        style={cropToImageStyle(cropX, cropY, cropSize)}
      />
    );
  }
  return <PhotoPlaceholder className="h-full w-full" />;
}
