// Picks iNaturalist observation photos to top up a thin reference gallery (top-up-galleries.ts).
import { toGalleryPhoto } from "@lifer/core/species/enrich.js";
import type { INaturalistPhoto } from "@lifer/core/species/inatClient.js";
import { isPublishableLicense } from "@lifer/core/species/licensePolicy.js";

/** iNaturalist's photo id from a photo URL, so one photo at another size or host still counts as
 *  the same; any other URL is its own key. */
export function photoKey(url: string): string {
  return url.match(/\/photos\/(\d+)\//)?.[1] ?? url;
}

/** Publishable gallery photos: the count the top-up fills up to. */
export function publishableCount(gallery: Array<{ license: string | null }>): number {
  return gallery.filter((p) => isPublishableLicense(p.license)).length;
}

/** The observation photos a gallery can take, best first: a publishable licence, and not already the
 *  species' main photo, in its gallery, or picked earlier in the list. */
export function topUpCandidates(photos: INaturalistPhoto[], existingUrls: Array<string | null>) {
  const seen = new Set(existingUrls.filter((u): u is string => !!u).map(photoKey));
  return photos.map(toGalleryPhoto).filter((p) => {
    const key = photoKey(p.photoUrl);
    if (!isPublishableLicense(p.license) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
