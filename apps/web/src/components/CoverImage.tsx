import ProgressiveImg from "./ProgressiveImg";
import PhotoPlaceholder from "./PhotoPlaceholder";
import { cropToImageStyle } from "../lib/crop";
import type { QuadSlot } from "@lifer/shared";

// Album and Trip cover: one cropped photo, or a 2x2 "quad" of four photos.
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
  /** Thumb-size URL. */
  coverPhotoUrl: string | null;
  cropX: number | null;
  cropY: number | null;
  cropSize: number | null;
  /** Always 4 entries; null renders an empty square. Trip slots carry null crops (plain cover fit). */
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
