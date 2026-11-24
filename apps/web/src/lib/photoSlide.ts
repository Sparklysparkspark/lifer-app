import type { LightboxSlide } from "../components/Lightbox";
import { photoFilePaths } from "./photoFilePaths";

/** What a library photo needs to show full size: the fields Gallery, album, trip and Trash items share. */
export interface SlidePhoto {
  photoId: string;
  kind?: string | null;
  width?: number | null;
  height?: number | null;
  captureId?: string | null;
  speciesId?: string | null;
  takenAt?: string | null;
  cameraModel?: string | null;
  lens?: string | null;
  focalLengthMm?: number | string | null;
  aperture?: number | string | null;
  shutter?: string | null;
  iso?: number | null;
  durationSeconds?: number | string | null;
  originalRef?: string | null;
  rawRef?: string | null;
}

/** A library photo as a Lightbox slide, the same on every page: its thumbnail shows at once while
 *  the full photo decodes (no black frame), videos and recordings play, and camera details show.
 *  `extra` adds the page's own caption and handlers (rating, tags, coordinates, frames). */
export function photoSlide(p: SlidePhoto, extra: Partial<LightboxSlide> = {}): LightboxSlide {
  const base = `/api/photos/${p.photoId}`;
  return {
    url: `${base}/display`,
    thumbUrl: `${base}/thumb`,
    width: p.width ?? null,
    height: p.height ?? null,
    videoUrl: p.kind === "video" ? `${base}/video` : null,
    audioUrl: p.kind === "audio" ? `${base}/audio` : null,
    speciesId: p.speciesId ?? null,
    ...(p.captureId ? { captureId: p.captureId } : {}),
    info: {
      cameraModel: p.cameraModel,
      lens: p.lens,
      focalLengthMm: p.focalLengthMm,
      aperture: p.aperture,
      shutter: p.shutter,
      iso: p.iso,
      takenAt: p.takenAt,
      durationSeconds: p.durationSeconds,
      files: photoFilePaths(p.originalRef, p.rawRef),
    },
    ...extra,
  };
}
