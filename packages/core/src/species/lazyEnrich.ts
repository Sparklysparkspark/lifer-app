// On-demand species enrichment: the reference photo, a short description and the gallery,
// fetched together the first time a species page is opened rather than for the whole catalog.
//
// iNaturalist only, no direct Wikipedia or Commons calls (Commons rate-limits hard). Calls to
// each host are paced (paceHost).
import { isPublishableLicense, normalizeLicense } from "./licensePolicy.js";
import { generateReferenceDerivatives } from "../uploads/image.js";
import { computeEmbedding, refreshSpeciesVectors } from "./embeddings.js";
import { log } from "../lib/log.js";
import { EMBEDDING_MODEL_VERSION, ID_MODEL_VERSION } from "../config.js";
import { idModel } from "./idModel.js";
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pool } from "../db.js";
import { composeDescription, htmlToText } from "./descriptionText.js";

const INAT_API = "https://api.inaturalist.org/v1";
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

// Every reference photo is cached locally; a failed download leaves that one photo hotlinked by
// URL. Only the hosts catalog and pack data use are fetched, and bodies are size-capped.
const REFERENCE_IMAGE_HOSTS = new Set([
  "inaturalist-open-data.s3.amazonaws.com",
  "static.inaturalist.org",
  "upload.wikimedia.org",
  "api.gbif.org",
]);
const REFERENCE_IMAGE_HOST_SUFFIXES = [".inaturalist.org", ".wikimedia.org"];
export const MAX_REFERENCE_IMAGE_BYTES = 25 * 1024 * 1024;

export function isAllowedReferenceImageUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  return REFERENCE_IMAGE_HOSTS.has(host) || REFERENCE_IMAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// Reads a response body, throwing once it passes maxBytes (declared or actual).
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Image too large (${declared} bytes)`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Image too large (over ${maxBytes} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export async function downloadAndCacheImage(
  url: string,
  key: string,
): Promise<{ displayPath: string; thumbPath: string } | null> {
  if (!isAllowedReferenceImageUrl(url)) {
    log.error({ url }, "Refusing to fetch a reference image from an unexpected host");
    return null;
  }
  try {
    // The same 429 backoff as metadata lookups: image hosts rate-limit too.
    const res = await fetchWithRetry(withoutTrackingParams(url));
    if (!res.ok) return null;
    // A redirect could land anywhere, so the final URL has to pass the same check.
    if (res.url && !isAllowedReferenceImageUrl(res.url)) {
      await res.body?.cancel().catch(() => {});
      log.error({ url: res.url }, "Reference image redirected to an unexpected host");
      return null;
    }
    const buffer = await readBodyCapped(res, MAX_REFERENCE_IMAGE_BYTES);
    return await generateReferenceDerivatives(buffer, key);
  } catch (err) {
    log.error({ err, url }, "Couldn't cache a reference image");
    return null;
  }
}

// Commons hands out image URLs with utm_ parameters, which make every request miss Wikimedia's CDN
// and hit the rate-limited origin. The stored URL keeps them; only the fetch drops them.
// Wikimedia's User-Agent policy asks for a contact; unidentified clients get stricter limits.
const USER_AGENT = "Lifer/0.7 (https://github.com/Sparklysparkspark/lifer-app)";

export function withoutTrackingParams(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (key.startsWith("utm_")) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url;
  }
}

// Per-host pacing: one enrichSpecies call makes several requests, so calls to a host are
// serialized at least MIN_HOST_INTERVAL_MS apart. Long bulk passes should raise
// INAT_MIN_HOST_INTERVAL_MS to avoid being throttled.
const MIN_HOST_INTERVAL_MS = Number(process.env.INAT_MIN_HOST_INTERVAL_MS) || 1000;
const hostQueues = new Map<string, Promise<void>>();
const lastCallAtByHost = new Map<string, number>();

function paceHost(host: string): Promise<void> {
  const prior = hostQueues.get(host) ?? Promise.resolve();
  const next = prior.then(async () => {
    const wait = (lastCallAtByHost.get(host) ?? 0) + MIN_HOST_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAtByHost.set(host, Date.now());
  });
  hostQueues.set(host, next);
  return next;
}

// Only iNaturalist's JSON API responses are cached, never image downloads.
const CACHEABLE_HOSTS = new Set(["api.inaturalist.org", "www.inaturalist.org"]);

async function getCachedInatResponse(url: string): Promise<string | null> {
  try {
    const res = await pool.query<{ response: string }>(`SELECT response FROM inat_response_cache WHERE url = $1`, [
      url,
    ]);
    return res.rows[0]?.response ?? null;
  } catch {
    return null;
  }
}

async function setCachedInatResponse(url: string, response: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO inat_response_cache (url, response) VALUES ($1, $2) ON CONFLICT (url) DO UPDATE SET response = EXCLUDED.response, fetched_at = now()`,
      [url, response],
    );
  } catch {
    // Best effort: a cache failure never fails the request.
  }
}

// The URLs of the two lookups enrichment starts with, which are also their inat_response_cache
// keys (the photo-withheld backfill reads them from there).
export const inatTaxonSearchUrl = (scientificName: string): string =>
  `${INAT_API}/taxa?q=${encodeURIComponent(scientificName)}&rank=species&is_active=true&per_page=10`;
export const inatTaxonUrl = (taxonId: number): string => `${INAT_API}/taxa/${taxonId}`;

// Thrown when iNaturalist is still throttling after every retry. Callers must not set
// enriched_at on it, which would record "no photo" for a species that may have one.
export class PersistentRateLimitError extends Error {}

export async function fetchWithRetry(url: string): Promise<Response> {
  const cacheable = CACHEABLE_HOSTS.has(new URL(url).host);
  if (cacheable) {
    const cached = await getCachedInatResponse(url);
    if (cached !== null) return new Response(cached, { status: 200 });
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= 3; attempt++) {
    let res: Response;
    try {
      await paceHost(new URL(url).host);
      // Without a timeout a hung connection blocks forever; this makes it a retryable error.
      res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // A dropped connection throws rather than returning a Response; retried the same way.
      lastError = err;
      log.warn(
        { host: new URL(url).host, err: err instanceof Error ? err.message : err },
        "iNaturalist network error, retrying",
      );
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status !== 429) {
      // Only a success is cached, so a transient error is retried next time.
      if (cacheable && res.ok) {
        const text = await res.clone().text();
        await setCachedInatResponse(url, text);
      }
      return res;
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
    log.warn(
      { host: new URL(url).host, backoffSeconds: Math.round(delayMs / 1000) },
      "Rate limited (429), backing off",
    );
    await new Promise((r) => setTimeout(r, delayMs));
  }
  try {
    const finalRes = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    // Still 429 means "try again later", not "nothing there", so it is thrown.
    if (finalRes.status === 429) throw new PersistentRateLimitError(`still rate-limited after retries: ${url}`);
    return finalRes;
  } catch (err) {
    throw err instanceof PersistentRateLimitError ? err : (lastError ?? err);
  }
}

// Lifer is personal use, so the species' default photo is used whatever its license, as viewing
// it on iNaturalist would show it.
interface INaturalistPhoto {
  medium_url: string;
  license_code: string | null;
  attribution: string;
}

export function toGalleryPhoto(photo: INaturalistPhoto): { photoUrl: string; credit: string; license: string } {
  const license = photo.license_code ? normalizeLicense(photo.license_code) : "all-rights-reserved";
  return { photoUrl: photo.medium_url, credit: photo.attribution, license };
}

// The first taxon photo, metadata only. default_photo isn't always flagged even when the taxon
// has photos, so callers that need one photo fall back to this.
export async function fetchFirstTaxonPhoto(taxonId: number): Promise<INaturalistPhoto | null> {
  const res = await fetchWithRetry(inatTaxonUrl(taxonId));
  if (!res.ok) return null;
  const data = (await res.json()) as { results: Array<{ taxon_photos?: Array<{ photo: INaturalistPhoto }> }> };
  return data.results[0]?.taxon_photos?.[0]?.photo ?? null;
}

// iNaturalist's search ranks by relevance, so only an exact name match counts, or a candidate
// that a committed taxon change (taxon_changes.json) lists the original name as an input for.
// Never a guess by name similarity.
async function findReclassifiedTaxon(
  scientificName: string,
  candidates: Array<{ id: number; name: string; default_photo: INaturalistPhoto | null }>,
): Promise<{ id: number; defaultPhoto: INaturalistPhoto | null } | null> {
  for (const candidate of candidates.slice(0, 5)) {
    const url = `https://www.inaturalist.org/taxon_changes.json?taxon_id=${candidate.id}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) continue;
    const changes = (await res.json()) as Array<{
      status: string;
      input_taxa: Array<{ name: string }>;
      output_taxa: Array<{ id: number }>;
    }>;
    const documented = changes.some(
      (c) =>
        c.status === "committed" &&
        c.output_taxa.some((o) => o.id === candidate.id) &&
        c.input_taxa.some((i) => i.name.toLowerCase() === scientificName.toLowerCase()),
    );
    if (documented) return { id: candidate.id, defaultPhoto: candidate.default_photo };
  }
  return null;
}

// A species in a split taxonomy can be a subspecies on iNaturalist (Anas carolinensis is Anas
// crecca carolinensis), which a species-rank search never finds.
async function fetchINaturalistSubspecies(
  scientificName: string,
): Promise<{ id: number; defaultPhoto: INaturalistPhoto | null } | null> {
  const url = `${INAT_API}/taxa?q=${encodeURIComponent(scientificName)}&is_active=true&per_page=10`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    results: Array<{ id: number; name: string; rank: string; default_photo: INaturalistPhoto | null }>;
  };
  const [genus, epithet] = scientificName.toLowerCase().split(" ");
  const exactMatch = data.results.find((r) => {
    const name = r.name.toLowerCase();
    return r.rank === "subspecies" && name.startsWith(`${genus} `) && name.endsWith(` ${epithet}`);
  });
  return exactMatch ? { id: exactMatch.id, defaultPhoto: exactMatch.default_photo } : null;
}

export async function fetchINaturalistTaxon(
  scientificName: string,
): Promise<{ id: number; defaultPhoto: INaturalistPhoto | null } | null> {
  const res = await fetchWithRetry(inatTaxonSearchUrl(scientificName));
  if (!res.ok) return null;
  const data = (await res.json()) as {
    results: Array<{ id: number; name: string; default_photo: INaturalistPhoto | null }>;
  };
  const exactMatch = data.results.find((r) => r.name.toLowerCase() === scientificName.toLowerCase());
  if (exactMatch) return { id: exactMatch.id, defaultPhoto: exactMatch.default_photo };
  const reclassified = await findReclassifiedTaxon(scientificName, data.results);
  if (reclassified) return reclassified;
  return fetchINaturalistSubspecies(scientificName);
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

// The description only, for backfilling text without downloading the gallery again.
export async function fetchINaturalistWikipediaSummary(
  taxonId: number,
): Promise<{ summary: string; wikipediaUrl: string } | null> {
  // Paced, retried and cached like every other iNaturalist call (fetchWithRetry).
  const res = await fetchWithRetry(inatTaxonUrl(taxonId));
  if (!res.ok) return null;
  const data = (await res.json()) as {
    results: Array<{ wikipedia_summary?: string | null; wikipedia_url?: string | null }>;
  };
  const taxon = data.results[0];
  const summary = descriptionFromINaturalistSummary(taxon?.wikipedia_summary, taxon?.wikipedia_url);
  return summary ? { summary, wikipediaUrl: normalizeWikipediaUrl(taxon!.wikipedia_url!) } : null;
}

/** The fields of an iNaturalist taxon record (/v1/taxa/{ids}) that enrichment reads. */
export interface INaturalistTaxonRecord {
  id: number;
  name: string;
  default_photo?: INaturalistPhoto | null;
  taxon_photos?: Array<{ photo: INaturalistPhoto }>;
  wikipedia_summary?: string | null;
  wikipedia_url?: string | null;
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
  // This used to be a bare fetch: unpaced (outside paceHost), never retried on 429 and uncached.
  // Under a bulk run's load iNaturalist throttled it, and a throttled answer read as "no
  // summary, no gallery" while the paced name search still found the photo, so the species was
  // stamped enriched_at with a photo and no description, and nothing ever looked again.
  const res = await fetchWithRetry(inatTaxonUrl(taxonId));
  if (!res.ok)
    return { gallery: [], wikipediaSummary: null, wikipediaUrl: null, photosWithheld: null, textChecked: false };
  const data = (await res.json()) as { results: INaturalistTaxonRecord[] };
  // An empty result is an answer too, but not about this taxon's text.
  if (!data.results?.[0])
    return { gallery: [], wikipediaSummary: null, wikipediaUrl: null, photosWithheld: null, textChecked: false };
  return taxonDetailFromRecord(data.results[0], excludePhotoUrl, speciesId, options);
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
  const species = { id: speciesId };
  let referencePhoto = inat?.photoUrl ?? null;
  let referenceCredit = inat?.credit ?? null;
  let referenceLicense = inat?.license ?? null;
  let gallery: EnrichmentResult["gallery"] = detail?.gallery ?? [];
  const inatWikipediaSummary: string | null = detail?.wikipediaSummary ?? null;
  const inatWikipediaUrl: string | null = detail?.wikipediaUrl ?? null;

  let referenceDisplayPath: string | null = null;
  let referenceThumbPath: string | null = null;
  if (referencePhoto) {
    const cached = await downloadAndCacheImage(referencePhoto, species.id);
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
  const description: string | null = inatWikipediaSummary;
  const descriptionCredit: string | null = inatWikipediaSummary ? INATURALIST_DESCRIPTION_CREDIT : null;
  const descriptionSourceUrl: string | null = inatWikipediaSummary ? inatWikipediaUrl : null;
  const habitatDescription: string | null = null;

  return {
    referencePhoto,
    referenceCredit,
    referenceLicense,
    referenceDisplayPath,
    referenceThumbPath,
    description,
    descriptionCredit,
    descriptionSourceUrl,
    habitatDescription,
    descriptionChecked: detail?.textChecked ?? false,
    gallery,
  };
}

/** The one write path for both the on-view enrichment and the bulk enrich-all-species script. */
export async function persistEnrichment(speciesId: string, enrichment: EnrichmentResult): Promise<void> {
  // A blocklisted main photo (a range map, say; migration 106) counts as no photo at all.
  if (enrichment.referencePhoto) {
    const blocked = await pool.query(`SELECT 1 FROM reference_photo_blocklist WHERE photo_url = $1`, [
      enrichment.referencePhoto,
    ]);
    if (blocked.rowCount) {
      for (const p of [enrichment.referenceDisplayPath, enrichment.referenceThumbPath])
        if (p) rmSync(p, { force: true });
      enrichment = {
        ...enrichment,
        referencePhoto: null,
        referenceCredit: null,
        referenceLicense: null,
        referenceDisplayPath: null,
        referenceThumbPath: null,
      };
    }
  }
  await pool.query(
    `UPDATE species SET
       reference_photo = COALESCE(reference_photo, $1),
       reference_credit = COALESCE(reference_credit, $2),
       reference_license = COALESCE(reference_license, $3),
       reference_display_path = COALESCE(reference_display_path, $4),
       reference_thumb_path = COALESCE(reference_thumb_path, $5),
       description = COALESCE(description, $6),
       description_credit = COALESCE(description_credit, $7),
       description_source_url = COALESCE(description_source_url, $8),
       habitat_description = COALESCE(habitat_description, $9),
       -- A species that already has a photo isn't missing one, whatever iNaturalist's licenses.
       photo_withheld = CASE WHEN $11::boolean IS NULL THEN photo_withheld
                             ELSE $11::boolean AND reference_photo IS NULL END,
       -- enriched_at says a photo lookup ran; text has its own stamp, set only when a text
       -- source was actually read (EnrichmentResult.descriptionChecked).
       description_checked_at = CASE WHEN $12::boolean THEN now() ELSE description_checked_at END,
       enriched_at = now()
     WHERE id = $10`,
    [
      enrichment.referencePhoto,
      enrichment.referenceCredit,
      enrichment.referenceLicense,
      enrichment.referenceDisplayPath,
      enrichment.referenceThumbPath,
      enrichment.description,
      enrichment.descriptionCredit,
      enrichment.descriptionSourceUrl,
      enrichment.habitatDescription,
      speciesId,
      enrichment.photoWithheld ?? null,
      enrichment.descriptionChecked ?? false,
    ],
  );
  await persistGallery(speciesId, enrichment.gallery);
  await tryComputeReferenceEmbedding(speciesId);
}

/** Text only, for a species some photo-only path marked enriched (an offline pack's photos, the
 *  photo store) without ever reading a text source. Reads iNaturalist's taxon record by id and
 *  stores its summary under the shared rule; stamps description_checked_at only when the record
 *  was read. Returns the stored description, or null. Never overwrites an existing one. */
export async function fillDescriptionIfUnchecked(
  speciesId: string,
  inatTaxonId: number,
): Promise<{ description: string; descriptionCredit: string; descriptionSourceUrl: string } | null> {
  const res = await fetchWithRetry(inatTaxonUrl(inatTaxonId));
  if (!res.ok) return null;
  const data = (await res.json()) as { results: INaturalistTaxonRecord[] };
  const taxon = data.results?.[0];
  if (!taxon) return null;
  const description = descriptionFromINaturalistSummary(taxon.wikipedia_summary, taxon.wikipedia_url);
  const sourceUrl = description ? normalizeWikipediaUrl(taxon.wikipedia_url!) : null;
  await pool.query(
    `UPDATE species SET
       description = COALESCE(description, $2),
       description_credit = CASE WHEN description IS NULL AND $2::text IS NOT NULL THEN $3 ELSE description_credit END,
       description_source_url = CASE WHEN description IS NULL AND $2::text IS NOT NULL THEN $4 ELSE description_source_url END,
       description_checked_at = now()
     WHERE id = $1`,
    [speciesId, description, description ? INATURALIST_DESCRIPTION_CREDIT : null, sourceUrl],
  );
  return description && sourceUrl
    ? { description, descriptionCredit: INATURALIST_DESCRIPTION_CREDIT, descriptionSourceUrl: sourceUrl }
    : null;
}

/** Stores a main photo for a species that still has none, with its credit and license, then its
 *  reference vectors. For the background fetch of photos packs can't include
 *  (apps/api/src/species/withheldPhotos.ts). False when it wasn't stored: the photo is
 *  blocklisted (migration 106) or the species got a photo meanwhile. */
export async function persistMainPhotoIfMissing(
  speciesId: string,
  photo: { photoUrl: string; credit: string; license: string; displayPath: string | null; thumbPath: string | null },
): Promise<boolean> {
  const blocked = await pool.query(`SELECT 1 FROM reference_photo_blocklist WHERE photo_url = $1`, [photo.photoUrl]);
  if (blocked.rowCount) {
    for (const p of [photo.displayPath, photo.thumbPath]) if (p) rmSync(p, { force: true });
    return false;
  }
  const res = await pool.query(
    `UPDATE species SET reference_photo = $2, reference_credit = $3, reference_license = $4,
       reference_display_path = $5, reference_thumb_path = $6
     WHERE id = $1 AND reference_photo IS NULL`,
    [speciesId, photo.photoUrl, photo.credit, photo.license, photo.displayPath, photo.thumbPath],
  );
  if (!res.rowCount) return false;
  await tryComputeReferenceEmbedding(speciesId);
  return true;
}

// Suggestions only rank species with a reference vector, so one is computed right after
// enrichment. Best effort: the backfill catches anything missed here.
async function tryComputeReferenceEmbedding(speciesId: string): Promise<void> {
  let stored = false;
  try {
    const res = await pool.query<{ reference_display_path: string | null }>(
      `SELECT reference_display_path FROM species
       WHERE id = $1 AND NOT EXISTS (
         SELECT 1 FROM species_reference_embeddings sre WHERE sre.species_id = species.id AND sre.model_version = $2
       )`,
      [speciesId, EMBEDDING_MODEL_VERSION],
    );
    const displayPath = res.rows[0]?.reference_display_path;
    if (!displayPath) return;
    const embedding = await computeEmbedding(await readFile(displayPath));
    await pool.query(
      `INSERT INTO species_reference_embeddings (species_id, embedding, model_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (species_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
      [speciesId, embedding, EMBEDDING_MODEL_VERSION],
    );
    stored = true;
  } catch {
    // Model not downloaded, image unreadable, inference timeout: left for the backfill.
  }
  if (await tryComputeIdReferenceEmbedding(speciesId)) stored = true;
  if (stored) await refreshSpeciesVectorsQuietly(speciesId);
}

// Loaded suggestion candidates pick up the new vectors now rather than on the next rebuild.
async function refreshSpeciesVectorsQuietly(speciesId: string): Promise<void> {
  await refreshSpeciesVectors(pool, [speciesId]).catch((err) =>
    log.warn({ err, speciesId }, "Couldn't refresh this species' loaded vectors"),
  );
}

// The species identification model's copy of the same vector. Species in the published catalog
// already have one; this covers Other Taxa and anything enriched since.
async function tryComputeIdReferenceEmbedding(speciesId: string): Promise<boolean> {
  if (!idModel.isDownloaded()) return false;
  try {
    const res = await pool.query<{ reference_display_path: string | null }>(
      `SELECT reference_display_path FROM species
       WHERE id = $1 AND NOT EXISTS (
         SELECT 1 FROM id_model_reference_embeddings e WHERE e.species_id = species.id AND e.model_version = $2
       )`,
      [speciesId, ID_MODEL_VERSION],
    );
    const displayPath = res.rows[0]?.reference_display_path;
    if (!displayPath) return false;
    const embedding = await idModel.embed(await readFile(displayPath));
    await pool.query(
      `INSERT INTO id_model_reference_embeddings (species_id, embedding, model_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (species_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
      [speciesId, embedding, ID_MODEL_VERSION],
    );
    return true;
  } catch {
    return false; // same best-effort contract as tryComputeReferenceEmbedding
  }
}

export async function persistGallery(speciesId: string, gallery: EnrichmentResult["gallery"]): Promise<void> {
  const blocked = await pool.query<{ photo_url: string }>(
    `SELECT photo_url FROM reference_photo_blocklist WHERE photo_url = ANY($1)`,
    [gallery.map((p) => p.photoUrl)],
  );
  const blockedUrls = new Set(blocked.rows.map((r) => r.photo_url));
  let stored = false;
  for (const photo of gallery) {
    if (blockedUrls.has(photo.photoUrl)) continue; // a map or other non-photo (migration 106)
    const res = await pool.query<{ id: string }>(
      `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, sort_order, display_path, thumb_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (species_id, photo_url) DO UPDATE SET
         display_path = EXCLUDED.display_path, thumb_path = EXCLUDED.thumb_path
       RETURNING id`,
      [speciesId, photo.photoUrl, photo.credit, photo.license, photo.sortOrder, photo.displayPath, photo.thumbPath],
    );
    if (await tryComputeGalleryEmbedding(res.rows[0].id, speciesId, photo.displayPath)) stored = true;
  }
  if (stored) await refreshSpeciesVectorsQuietly(speciesId);
}

// The same as tryComputeReferenceEmbedding, for one gallery photo. True when a vector was stored.
async function tryComputeGalleryEmbedding(
  referencePhotoId: string,
  speciesId: string,
  displayPath: string | null,
): Promise<boolean> {
  if (!displayPath) return false;
  let stored = false;
  try {
    const existing = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM species_reference_gallery_embeddings WHERE reference_photo_id = $1 AND model_version = $2
       ) AS exists`,
      [referencePhotoId, EMBEDDING_MODEL_VERSION],
    );
    if (existing.rows[0].exists) return false;
    const embedding = await computeEmbedding(await readFile(displayPath));
    await pool.query(
      `INSERT INTO species_reference_gallery_embeddings (reference_photo_id, species_id, embedding, model_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (reference_photo_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
      [referencePhotoId, speciesId, embedding, EMBEDDING_MODEL_VERSION],
    );
    stored = true;
  } catch {
    // Model not downloaded, image unreadable, inference timeout: left for the backfill.
  }
  if (await tryComputeIdGalleryEmbedding(referencePhotoId, speciesId, displayPath)) stored = true;
  return stored;
}

async function tryComputeIdGalleryEmbedding(
  referencePhotoId: string,
  speciesId: string,
  displayPath: string,
): Promise<boolean> {
  if (!idModel.isDownloaded()) return false;
  try {
    const existing = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM id_model_gallery_embeddings WHERE reference_photo_id = $1 AND model_version = $2
       ) AS exists`,
      [referencePhotoId, ID_MODEL_VERSION],
    );
    if (existing.rows[0].exists) return false;
    const embedding = await idModel.embed(await readFile(displayPath));
    await pool.query(
      `INSERT INTO id_model_gallery_embeddings (reference_photo_id, species_id, embedding, model_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (reference_photo_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
      [referencePhotoId, speciesId, embedding, ID_MODEL_VERSION],
    );
    return true;
  } catch {
    return false; // same best-effort contract as tryComputeReferenceEmbedding
  }
}

// For the gallery backfills (the species page and backfill-missing-galleries.ts): a species with
// no main photo gets the first gallery photo as its main one, as enrichSpecies does.
export async function persistGalleryPromotingMainIfMissing(
  speciesId: string,
  gallery: EnrichmentResult["gallery"],
  hasMainPhoto: boolean,
): Promise<void> {
  if (hasMainPhoto || gallery.length === 0) {
    await persistGallery(speciesId, gallery);
    return;
  }
  const [first, ...rest] = gallery;
  await pool.query(
    `UPDATE species SET reference_photo = $1, reference_credit = $2, reference_license = $3,
       reference_display_path = $4, reference_thumb_path = $5 WHERE id = $6`,
    [first.photoUrl, first.credit, first.license, first.displayPath, first.thumbPath, speciesId],
  );
  await persistGallery(speciesId, rest);
  await tryComputeReferenceEmbedding(speciesId);
}
