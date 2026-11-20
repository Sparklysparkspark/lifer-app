import type { LightboxSlide } from "../Lightbox";
import type { GalleryItem } from "../../pages/gallery/types";
import { formatDate } from "../../lib/format";
import { photoFilePaths } from "../../lib/photoFilePaths";

/** A Gallery photo as a Lightbox slide, the same from the side panel and the hover card. */
export function gallerySlide(
  i: GalleryItem,
  speciesName: (item: GalleryItem) => string,
  onRate: (rating: number | null) => void,
): LightboxSlide {
  return {
    url: `/api/photos/${i.photoId}/display`,
    thumbUrl: `/api/photos/${i.photoId}/thumb`,
    width: i.width,
    height: i.height,
    videoUrl: i.kind === "video" ? `/api/photos/${i.photoId}/video` : null,
    audioUrl: i.kind === "audio" ? `/api/photos/${i.photoId}/audio` : null,
    caption: slideCaption(i, speciesName),
    speciesId: i.speciesId,
    captureId: i.captureId,
    rating: i.qualityRating,
    onRate,
    info: {
      cameraModel: i.cameraModel,
      lens: i.lens,
      focalLengthMm: i.focalLengthMm,
      aperture: i.aperture,
      shutter: i.shutter,
      iso: i.iso,
      takenAt: i.takenAt,
      files: photoFilePaths(i.originalRef, i.rawRef),
    },
  };
}

/** "Bald Eagle, Apr 2, 2026". */
export const slideCaption = (i: GalleryItem, speciesName: (item: GalleryItem) => string) =>
  `${speciesName(i)}${i.takenAt ? `, ${formatDate(i.takenAt, "medium")}` : ""}`;
