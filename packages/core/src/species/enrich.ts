// On-demand species enrichment: the reference photo, a short description and the gallery,
// fetched together the first time a species page is opened rather than for the whole catalog.
// This builds the result; persistReference.ts stores it.
import { isPublishableLicense, normalizeLicense } from "./licensePolicy.js";
import { composeDescription, htmlToText } from "./descriptionText.js";
import {
  downloadAndCacheImage,
  fetchINaturalistTaxon,
  fetchTaxonRecord,
  type INaturalistPhoto,
  type INaturalistTaxonRecord,
} from "./inatClient.js";

const MAX_GALLERY_PHOTOS = 6;

export interface EnrichmentResult {
  referencePhoto: string | null;
  referenceCredit: string | null;
  referenceLicense: string | null;
  referenceDisplayPath: string | null;
  referenceThumbPath: string | null;
  description: string | null;
  descriptionCredit: string | null;
  descriptionSourceUrl: string | null;
  habitatDescription: string | null;
  /** True when a text source (the iNaturalist taxon record, which carries the Wikipedia summary)
   *  was actually read, whether or not it had a summary. persistEnrichment stamps
   *  description_checked_at only then, so a failed or skipped text lookup is never recorded as
   *  "checked, nothing there" (migration 128). */
  descriptionChecked?: boolean;
  gallery: Array<{
    photoUrl: string;
    credit: string;
    license: string;
    sortOrder: number;
    displayPath: string | null;
    thumbPath: string | null;
  }>;
  /** publishableOnly runs only: true when iNaturalist has photos for the species but none Lifer
   *  may publish, false when it has a publishable one or none at all. Undefined when unknown
   *  (personal enrichment, or iNaturalist couldn't be read), so the stored flag is kept. */
  photoWithheld?: boolean;
}

export function toGalleryPhoto(photo: INaturalistPhoto): { photoUrl: string; credit: string; license: string } {
  const license = photo.license_code ? normalizeLicense(photo.license_code) : "all-rights-reserved";
  return { photoUrl: photo.medium_url, credit: photo.attribution, license };
}

// iNaturalist's taxon record carries the gallery and a Wikipedia summary in one request. No
// license filtering (see toGalleryPhoto).
export function stripHtml(html: string): string {
  return htmlToText(html);
}

/** iNaturalist's wikipedia_summary (the article lead, cut off at about 450 characters with
 *  "...") through the shared description rule (descriptionText.ts), or null. The summary needs a
 *  wikipedia_url too: species.description_requires_credit needs a source URL with any text. */
export function descriptionFromINaturalistSummary(
  summary: string | null | undefined,
  wikipediaUrl: string | null | undefined,
): string | null {
  if (!summary || !wikipediaUrl) return null;
  return composeDescription({ lead: htmlToText(summary), leadTruncated: /(\.\.\.|…)\s*$/.test(summary) });
}

/** The credit and URL stored with an iNaturalist-sourced description. iNaturalist hands out
 *  URLs with a raw space ("wiki/Thamnophis sirtalis"), so they're encoded. */
export const INATURALIST_DESCRIPTION_CREDIT = "Wikipedia contributors (CC BY-SA), via iNaturalist";
export function normalizeWikipediaUrl(url: string): string {
  return url.replace(/^http:/, "https:").replace(/ /g, "_");
}

/** publishableOnly: for the data pipeline, whose photos are published in packs. Only photos whose
 *  license allows that (licensePolicy.ts's isPublishableLicense) are used, so a species gets an
 *  allowed photo when iNaturalist has one instead of losing its photo to the license policy, and
 *  photos that couldn't be published aren't downloaded at all. Off for personal viewing. */
export interface EnrichOptions {
  publishableOnly?: boolean;
}

interface TaxonDetail {
  gallery: EnrichmentResult["gallery"];
  wikipediaSummary: string | null;
  wikipediaUrl: string | null;
  /** Whether publishableOnly left out any of the taxon's photos; null when the record couldn't be read. */
  photosWithheld: boolean | null;
  /** Whether the taxon record (and so its Wikipedia summary) was actually read. */
  textChecked: boolean;
}

async function fetchINaturalistTaxonDetail(
  taxonId: number,
  excludePhotoUrl: string | null,
  speciesId: string,
  options: EnrichOptions = {},
): Promise<TaxonDetail> {
  // Paced, retried and cached like the name search: a throttled answer must not read as "no
  // summary, no gallery" while the search still found the photo.
  const taxon = await fetchTaxonRecord(taxonId);
  // An empty result is an answer too, but not about this taxon's text.
  if (!taxon)
    return { gallery: [], wikipediaSummary: null, wikipediaUrl: null, photosWithheld: null, textChecked: false };
  return taxonDetailFromRecord(taxon, excludePhotoUrl, speciesId, options);
}

/** Gallery (cached locally) and Wikipedia summary from a taxon record already fetched. */
export async function taxonDetailFromRecord(
  taxon: INaturalistTaxonRecord | undefined,
  excludePhotoUrl: string | null,
  speciesId: string,
  options: EnrichOptions = {},
): Promise<TaxonDetail> {
  const candidates = (taxon?.taxon_photos ?? []).map((tp) => tp.photo).filter((p) => p.medium_url !== excludePhotoUrl);
  const allowed = candidates.filter((p) => !options.publishableOnly || isPublishableLicense(toGalleryPhoto(p).license));
  const photos = allowed.slice(0, MAX_GALLERY_PHOTOS);

  const gallery: EnrichmentResult["gallery"] = [];
  for (const photo of photos) {
    const mapped = toGalleryPhoto(photo);
    const cached = await downloadAndCacheImage(mapped.photoUrl, `${speciesId}-gallery-${gallery.length}`);
    gallery.push({
      ...mapped,
      sortOrder: gallery.length,
      displayPath: cached?.displayPath ?? null,
      thumbPath: cached?.thumbPath ?? null,
    });
  }
  // The shared description rule (descriptionText.ts); a summary without wikipedia_url counts as
  // none (description_requires_credit).
  const wikipediaSummary = descriptionFromINaturalistSummary(taxon?.wikipedia_summary, taxon?.wikipedia_url);
  const wikipediaUrl = wikipediaSummary ? normalizeWikipediaUrl(taxon!.wikipedia_url!) : null;
  const photosWithheld = allowed.length < candidates.length;
  return { gallery, wikipediaSummary, wikipediaUrl, photosWithheld, textChecked: taxon != null };
}

// The gallery alone, used by enrichSpecies and the species page's gallery backfill.
export async function fetchAnyGallery(species: {
  id: string;
  scientific_name: string;
  reference_photo: string | null;
}): Promise<EnrichmentResult["gallery"]> {
  const taxon = await fetchINaturalistTaxon(species.scientific_name);
  if (!taxon) return [];
  return (await fetchINaturalistTaxonDetail(taxon.id, species.reference_photo, species.id)).gallery;
}

export async function enrichSpecies(
  species: {
    id: string;
    scientific_name: string;
  },
  options: EnrichOptions = {},
): Promise<EnrichmentResult> {
  const taxon = await fetchINaturalistTaxon(species.scientific_name);
  const inat = mainPhotoCandidate(taxon?.defaultPhoto ?? null, options);
  const detail = taxon
    ? await fetchINaturalistTaxonDetail(taxon.id, inat?.photoUrl ?? null, species.id, options)
    : null;
  const result = await assembleEnrichment(species.id, inat, detail);
  // No taxon found can also be a failed search, so it says nothing about the photo.
  return taxon ? withPhotoWithheld(result, taxon.defaultPhoto ?? null, detail, options) : result;
}

// publishableOnly only: whether the species is left photoless because of licenses alone.
function withPhotoWithheld(
  result: EnrichmentResult,
  defaultPhoto: INaturalistPhoto | null,
  detail: TaxonDetail | null,
  options: EnrichOptions,
): EnrichmentResult {
  if (!options.publishableOnly) return result;
  if (result.referencePhoto) return { ...result, photoWithheld: false };
  const defaultWithheld = defaultPhoto !== null && !isPublishableLicense(toGalleryPhoto(defaultPhoto).license);
  if (defaultWithheld || detail?.photosWithheld) return { ...result, photoWithheld: true };
  if (detail?.photosWithheld === null) return result;
  return { ...result, photoWithheld: false };
}

// The default photo, unless publishableOnly rules it out; then the gallery's first photo, already
// limited to publishable ones, becomes the main photo (assembleEnrichment).
function mainPhotoCandidate(photo: INaturalistPhoto | null, options: EnrichOptions) {
  const mapped = photo ? toGalleryPhoto(photo) : null;
  return mapped && options.publishableOnly && !isPublishableLicense(mapped.license) ? null : mapped;
}

/** Enrichment for a taxon record fetched in a batch, the same result enrichSpecies builds. */
export async function enrichmentFromTaxonRecord(
  speciesId: string,
  taxon: INaturalistTaxonRecord,
  options: EnrichOptions = {},
): Promise<EnrichmentResult> {
  const inat = mainPhotoCandidate(taxon.default_photo ?? null, options);
  const detail = await taxonDetailFromRecord(taxon, inat?.photoUrl ?? null, speciesId, options);
  const result = await assembleEnrichment(speciesId, inat, detail);
  return withPhotoWithheld(result, taxon.default_photo ?? null, detail, options);
}

async function assembleEnrichment(
  speciesId: string,
  inat: { photoUrl: string; credit: string; license: string } | null,
  detail: TaxonDetail | null,
): Promise<EnrichmentResult> {
  let referencePhoto = inat?.photoUrl ?? null;
  let referenceCredit = inat?.credit ?? null;
  let referenceLicense = inat?.license ?? null;
  let gallery: EnrichmentResult["gallery"] = detail?.gallery ?? [];
  const inatWikipediaSummary: string | null = detail?.wikipediaSummary ?? null;
  const inatWikipediaUrl: string | null = detail?.wikipediaUrl ?? null;

  let referenceDisplayPath: string | null = null;
  let referenceThumbPath: string | null = null;
  if (referencePhoto) {
    const cached = await downloadAndCacheImage(referencePhoto, speciesId);
    referenceDisplayPath = cached?.displayPath ?? null;
    referenceThumbPath = cached?.thumbPath ?? null;
  } else if (gallery.length > 0) {
    // default_photo isn't always flagged even when the gallery has photos, so the first gallery
    // photo (already cached) becomes the main one.
    const [first, ...rest] = gallery;
    referencePhoto = first.photoUrl;
    referenceCredit = first.credit;
    referenceLicense = first.license;
    referenceDisplayPath = first.displayPath;
    referenceThumbPath = first.thumbPath;
    gallery = rest;
  }

  // iNaturalist only: no summary there means no description. The Wikipedia backfill
  // (data-pipeline backfill-descriptions.ts) looks up the article directly for the rest.
  return {
    referencePhoto,
    referenceCredit,
    referenceLicense,
    referenceDisplayPath,
    referenceThumbPath,
    description: inatWikipediaSummary,
    descriptionCredit: inatWikipediaSummary ? INATURALIST_DESCRIPTION_CREDIT : null,
    descriptionSourceUrl: inatWikipediaSummary ? inatWikipediaUrl : null,
    habitatDescription: null,
    descriptionChecked: detail?.textChecked ?? false,
    gallery,
  };
}
