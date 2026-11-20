import { isOpenVectorLicense } from "@lifer/core/species/licensePolicy.js";

/** Gallery vectors kept per species. */
export const OPEN_VECTORS_MAX = 6;
/** A species with fewer open vectors than this keeps its other ones too, so matching doesn't thin out. */
export const OPEN_VECTORS_MIN = 3;

export interface GalleryVector {
  photoId: string;
  license: string | null;
}

/** The vectors a species ships in the open-vectors mode: its open ones (up to OPEN_VECTORS_MAX,
 *  in the order given, best first); and only when it has fewer than OPEN_VECTORS_MIN of those, the
 *  others fill up to the same total. */
export function chooseGalleryVectors(vectors: GalleryVector[]): GalleryVector[] {
  const open = vectors.filter((v) => isOpenVectorLicense(v.license));
  if (open.length >= OPEN_VECTORS_MIN) return open.slice(0, OPEN_VECTORS_MAX);
  const rest = vectors.filter((v) => !isOpenVectorLicense(v.license));
  return [...open, ...rest].slice(0, OPEN_VECTORS_MAX);
}
