import type { LightboxSlide } from "../../components/Lightbox";

/** One photo in a chart mark's set (PhotoSetModal). */
export interface PhotoSetPhoto {
  photoId: string;
  caption?: string | null;
  info?: LightboxSlide["info"];
}

export function slidesFor(photos: PhotoSetPhoto[]): LightboxSlide[] {
  return photos.map((p) => ({
    url: `/api/photos/${p.photoId}/display`,
    thumbUrl: `/api/photos/${p.photoId}/thumb`,
    caption: p.caption,
    info: p.info,
  }));
}
