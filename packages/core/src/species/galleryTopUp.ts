// Picks iNaturalist observation photos to top up a thin reference gallery: the pipeline's
// top-up-galleries.ts for the catalog, and topUpGalleryFromObservations for Other Taxa.
import { pool } from "../db.js";
import { MAX_GALLERY_PHOTOS, toGalleryPhoto, type EnrichmentResult } from "./enrich.js";
import { downloadAndCacheImage, fetchObservationPhotos, type INaturalistPhoto } from "./inatClient.js";
import { INAT_PUBLISHABLE_LICENSE_CODES, isPublishableLicense } from "./licensePolicy.js";
import { persistGalleryPromotingMainIfMissing } from "./persistReference.js";

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

/** Fills a species' gallery up to MAX_GALLERY_PHOTOS with research-grade iNaturalist observation
 *  photos, so a species with few taxon photos still gets gallery vectors to match against. No
 *  portrait filter: its prompts are tuned for animals and would turn plants away as habitat.
 *  Returns how many photos were added; null when iNaturalist didn't answer. */
export async function topUpGalleryFromObservations(speciesId: string): Promise<number | null> {
  const res = await pool.query<{ inat_taxon_id: number | null; reference_photo: string | null; urls: string[]; max_sort: number }>(
    `SELECT s.inat_taxon_id, s.reference_photo,
            coalesce(array_agg(g.photo_url) FILTER (WHERE g.id IS NOT NULL), '{}') AS urls,
            coalesce(max(g.sort_order), -1) AS max_sort
       FROM species s LEFT JOIN species_reference_photos g ON g.species_id = s.id
      WHERE s.id = $1 GROUP BY s.id`,
    [speciesId],
  );
  const r = res.rows[0];
  if (!r?.inat_taxon_id) return 0;
  // A species without a main photo promotes the first one added, which leaves the gallery.
  const need = MAX_GALLERY_PHOTOS - r.urls.length + (r.reference_photo ? 0 : 1);
  if (need <= 0) return 0;
  const photos = await fetchObservationPhotos(r.inat_taxon_id, INAT_PUBLISHABLE_LICENSE_CODES, MAX_GALLERY_PHOTOS * 2);
  if (photos === null) return null;
  const added: EnrichmentResult["gallery"] = [];
  for (const c of topUpCandidates(photos, [r.reference_photo, ...r.urls])) {
    if (added.length >= need) break;
    const cached = await downloadAndCacheImage(c.photoUrl, `${speciesId}-gallery-inat-${photoKey(c.photoUrl)}`);
    if (cached) added.push({ ...c, sortOrder: r.max_sort + 1 + added.length, ...cached });
  }
  if (added.length > 0) await persistGalleryPromotingMainIfMissing(speciesId, added, r.reference_photo !== null);
  return added.length;
}
