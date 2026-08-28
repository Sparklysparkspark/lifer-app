// On-demand species enrichment — reference photo, a one-sentence ID blurb, and the
// reference-photo gallery, all fetched together the first time a species detail page is
// opened, instead of the full ~11,000 species backbone doing this eagerly (estimated 8+ hours
// for species that may never be viewed).
//
// iNaturalist ONLY — no direct Wikipedia or Wikimedia Commons calls anywhere in this file.
// This was a hard-won lesson, not a style preference: Commons rate-limits for real (a live
// 429 with Retry-After: 600, i.e. a genuine 10-minute ban was reproduced and confirmed while
// debugging this). A prior version of this file kept a Wikipedia/Commons fallback path "just
// in case iNaturalist has nothing," which is exactly what caused a real species (Green-Winged
// Teal / Anas carolinensis) to hang for minutes on every single page view. Do not reintroduce
// a Wikimedia fallback here — a species iNaturalist has nothing for gets an honest empty
// gallery/description, not a slow retry against a host known to ban this app.
//
// iNaturalist itself is much better-behaved than Commons was, but is NOT rate-limit-free —
// a bulk pass (enrich-all-species.ts) at even modest concurrency still drew real 429s from
// api.inaturalist.org, since one enrichSpecies call alone fires several requests back-to-back.
// See fetchWithRetry's own comment for the per-host pacing that actually fixes this.
import { normalizeLicense } from "./licensePolicy.js";
import { generateReferenceDerivatives } from "../uploads/image.js";
import { pool } from "../db.js";

const INAT_API = "https://api.inaturalist.org/v1";
const MAX_GALLERY_PHOTOS = 6;
const DECIMAL_MARKER = "@@DECIMALPOINT@@";

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
  gallery: Array<{
    photoUrl: string;
    credit: string;
    license: string;
    sortOrder: number;
    displayPath: string | null;
    thumbPath: string | null;
  }>;
}

// Caches a local copy of every reference photo (main + gallery) instead of only ever
// hotlinking the external URL — faster page loads, no dependency on iNaturalist/Commons
// uptime, and something usable for a future "download a region for offline" feature to
// bundle. Downloading/resizing is best-effort: a failure here (network blip, corrupt image)
// just means that one photo stays hotlinked via its URL rather than failing the whole
// enrichment pass — the URL/credit/license are always kept regardless.
export async function downloadAndCacheImage(url: string, key: string): Promise<{ displayPath: string; thumbPath: string } | null> {
  try {
    // Downloading ~4,900 images at concurrency 4 with a plain fetch (no retry-on-429) got
    // rate-limited by Wikimedia hard enough that roughly 80% of requests came back 429 and
    // were silently treated as "no photo available" — the same backoff-and-retry
    // fetchWithRetry already applies to metadata lookups was missing for the actual image
    // bytes.
    const res = await fetchWithRetry(url);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return await generateReferenceDerivatives(buffer, key);
  } catch (err) {
    console.error(`[lazyEnrich] failed to cache image ${url}:`, err);
    return null;
  }
}

// Per-host pacing — a bulk pass (enrich-all-species.ts) at even modest concurrency turned out
// to still draw 429s from api.inaturalist.org: a single enrichSpecies call fires several
// requests back-to-back on its own (taxon search, taxon detail, sometimes a subspecies/taxon-
// change lookup), so concurrency alone doesn't cap the real request rate to that host. This
// serializes every call to the SAME host at least MIN_INTERVAL_MS apart, regardless of how
// many concurrent callers (or how many sequential calls within one enrichSpecies) are asking —
// a chained-promise queue per host, same pattern as trips/tripIndex.ts's own per-folder write
// queue. iNaturalist's own API guidance suggests roughly 1 request/second unauthenticated.
// Measured against a real bulk run (~5,400 species): 1000ms still drew frequent 429s, but a
// slower 2500ms interval measured WORSE real throughput (fewer errors, but a lower net
// species/hour — the errors' own short backoffs cost less than the wider base interval does),
// so 1000ms is the deliberately-kept value despite the visible 429 log noise. Re-measure
// against the database directly (species enriched per minute), not just the 429 count, before
// changing this again. The S3 photo bucket is a different host and queues (and paces)
// separately, so this doesn't slow down image downloads. A single species page's first-ever
// view (the lazy
// path) pays a few seconds of this once, cached in the DB forever after — a fine trade for not
// getting blocked.
const MIN_HOST_INTERVAL_MS = 1000;
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

export async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= 3; attempt++) {
    let res: Response;
    try {
      await paceHost(new URL(url).host);
      res = await fetch(url, { headers: { "User-Agent": "lifer-api/0.1 (personal project)" } });
    } catch (err) {
      // A dropped connection ("SocketError: other side closed") throws instead of resolving
      // to a Response at all — this had no handling for that at all (only ever retried a 429
      // status), so one network blip crashed the whole calling script instead of retrying.
      // Same fix as data-pipeline's own fetch-with-retry.ts for the identical bug.
      lastError = err;
      console.error(`[lazyEnrich] network error for ${new URL(url).host}, retrying:`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status !== 429) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
    console.error(`[lazyEnrich] 429 from ${new URL(url).host}, backing off ${Math.round(delayMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  try {
    return await fetch(url);
  } catch (err) {
    throw lastError ?? err;
  }
}

// This is a personal, single-user app, not a redistribution product, so the earlier
// commercial-safe-CC-license + open-data-bucket-only restriction (which existed for a
// hypothetical public/commercial release) does not apply here — the species' default photo
// from iNaturalist is used as-is, including "all rights reserved" ones, the same as viewing
// the photo on iNaturalist's own site would show. This was also the real throughput
// bottleneck: most default photos are not yet in iNat's curated open-data S3 bucket even
// when the license itself was fine, so almost every species was falling back to the much
// slower, Wikimedia-rate-limited Commons path unnecessarily.
interface INaturalistPhoto {
  medium_url: string;
  license_code: string | null;
  attribution: string;
}

export function toGalleryPhoto(photo: INaturalistPhoto): { photoUrl: string; credit: string; license: string } {
  const license = photo.license_code ? normalizeLicense(photo.license_code) : "all-rights-reserved";
  return { photoUrl: photo.medium_url, credit: photo.attribution, license };
}

// Sibling of fetchINaturalistTaxonDetail, but metadata-only — no download/cache of any photo.
// A taxon record's default_photo flag is a curator quirk, not a reliable "has a photo" signal
// (see persistGalleryPromotingMainIfMissing's comment below for the same finding from the
// gallery-backfill side) — this lets a caller that only cares about ONE usable photo (e.g.
// switch-wikimedia-species-to-inaturalist.ts) fall back to the first real taxon_photos entry
// without paying for fetchINaturalistTaxonDetail's full gallery download.
export async function fetchFirstTaxonPhoto(taxonId: number): Promise<INaturalistPhoto | null> {
  const url = `${INAT_API}/taxa/${taxonId}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;
  const data = (await res.json()) as { results: Array<{ taxon_photos?: Array<{ photo: INaturalistPhoto }> }> };
  return data.results[0]?.taxon_photos?.[0]?.photo ?? null;
}

// iNaturalist's own taxon search ranks by relevance, not exact-name-match-first — searching
// "Cygnus cygnus" returns "Cygnus olor" as result #1, with Cygnus cygnus itself showing up
// 4th. Taking results[0] unconditionally would silently attach the wrong species' photo.
// Fetching more candidates and requiring an exact (case-insensitive) name match fixes this;
// if no exact match appears at all, this returns null (no taxon, not a guess) rather than
// attaching a plausible-but-wrong one.
//
// A plain exact-name miss is not always "no photo exists": sometimes the taxon itself was
// renamed or reclassified since the GBIF-sourced name was recorded. For example, Bison bison
// has real iNaturalist photos under a different current name, "Bos bison," after
// iNaturalist committed a TaxonSwap moving it back to Bos to maintain monophyly.
// iNaturalist's own site exposes a dated, committed record of these changes
// (taxon_changes.json — not part of the documented v1 API, but a live, verifiable feed of
// the same TaxonSwap/TaxonMerge/TaxonSplit history browsable at
// inaturalist.org/taxon_changes) with explicit input/output taxa. Checking a failed-exact-
// match candidate against this before giving up means an outdated name does not silently
// read as "no photo available anywhere" — it only accepts a candidate whose committed
// change record explicitly lists the original exact name as an input taxon, never a guess
// based on name similarity alone.
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

// Some species in our own DB (following a "split" taxonomy — e.g. Clements/eBird treating
// Green-Winged Teal as its own species, Anas carolinensis) are classified by iNaturalist as a
// SUBSPECIES of a different, "lumped" parent species instead (confirmed: iNaturalist has no
// species-rank Anas carolinensis at all — it's Anas crecca carolinensis, a subspecies of Anas
// crecca). A rank=species-only search can never find these, silently reading as "no photo
// exists" for a bird that actually has real iNaturalist photos, just filed one rank down.
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
  const url = `${INAT_API}/taxa?q=${encodeURIComponent(scientificName)}&rank=species&is_active=true&per_page=10`;
  const res = await fetchWithRetry(url);
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

// iNaturalist's own taxon record carries a full photo gallery (taxon_photos — e.g. 12
// photos for Cygnus cygnus alone) and a wikipedia_summary field (real Wikipedia-sourced
// intro text, the same article that would otherwise be fetched separately) in one fast
// request. Unlike the Wikipedia-media-list + per-photo Wikimedia-Commons-metadata approach
// below, this endpoint shows no rate-limiting, so it doesn't need the per-request mutex at
// all, and sourcing the summary from here means one fewer direct Wikipedia call per species.
// Same "personal use" license stance as the main photo (see fetchINaturalistTaxon's
// neighboring comment) — no license filtering.
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#?\w+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Lightweight sibling of fetchINaturalistTaxonDetail for the description-only backfill —
// that function also downloads/caches every gallery photo, which would be pure waste for
// species that are already fully enriched and just need their description/habitat text
// upgraded.
export async function fetchINaturalistWikipediaSummary(
  taxonId: number,
): Promise<{ summary: string; wikipediaUrl: string } | null> {
  const url = `${INAT_API}/taxa/${taxonId}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    results: Array<{ wikipedia_summary?: string | null; wikipedia_url?: string | null }>;
  };
  const taxon = data.results[0];
  const summary = taxon?.wikipedia_summary;
  // species.description_requires_credit CHECK requires a non-null source URL alongside any
  // non-null description (this constraint was violated during backfill for species such as
  // Accipiter gentilis and Aeorestes cinereus) — a species with no wikipedia_url here has no
  // citable source at all, so it is treated the same as "no summary" rather than writing a
  // description with nothing to back it.
  if (!summary || !taxon?.wikipedia_url) return null;
  const truncated = truncateToSentences(stripHtml(summary), 4);
  return truncated ? { summary: truncated, wikipediaUrl: taxon.wikipedia_url } : null;
}

async function fetchINaturalistTaxonDetail(
  taxonId: number,
  excludePhotoUrl: string | null,
  speciesId: string,
): Promise<{ gallery: EnrichmentResult["gallery"]; wikipediaSummary: string | null; wikipediaUrl: string | null }> {
  const url = `${INAT_API}/taxa/${taxonId}`;
  const res = await fetch(url);
  if (!res.ok) return { gallery: [], wikipediaSummary: null, wikipediaUrl: null };
  const data = (await res.json()) as {
    results: Array<{
      taxon_photos?: Array<{ photo: INaturalistPhoto }>;
      wikipedia_summary?: string | null;
      wikipedia_url?: string | null;
    }>;
  };
  const taxon = data.results[0];
  const photos = (taxon?.taxon_photos ?? [])
    .map((tp) => tp.photo)
    .filter((p) => p.medium_url !== excludePhotoUrl)
    .slice(0, MAX_GALLERY_PHOTOS);

  const gallery: EnrichmentResult["gallery"] = [];
  for (const photo of photos) {
    const mapped = toGalleryPhoto(photo);
    const cached = await downloadAndCacheImage(mapped.photoUrl, `${speciesId}-gallery-${gallery.length}`);
    gallery.push({ ...mapped, sortOrder: gallery.length, displayPath: cached?.displayPath ?? null, thumbPath: cached?.thumbPath ?? null });
  }
  // iNaturalist's own summary is often trimmed mid-sentence — trim back to the last complete
  // sentence rather than showing a dangling half-thought.
  // species.description_requires_credit CHECK needs a non-null source URL alongside any
  // non-null description (this constraint was violated for species such as Accipiter
  // gentilis and Aeorestes cinereus) — a summary with no wikipedia_url is treated as absent
  // rather than risking that constraint violation, now that Wikipedia is no longer called
  // unconditionally as a fallback source for descriptionSourceUrl.
  const wikipediaSummary =
    taxon?.wikipedia_summary && taxon.wikipedia_url ? truncateToSentences(stripHtml(taxon.wikipedia_summary), 4) : null;
  const wikipediaUrl = wikipediaSummary ? taxon!.wikipedia_url! : null;
  return { gallery, wikipediaSummary: wikipediaSummary || null, wikipediaUrl };
}

function truncateToSentences(text: string, maxSentences: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const marked = normalized.replace(/(\d)\.(\d)/g, "$1" + DECIMAL_MARKER + "$2");
  const sentences = marked.split(/(?<=[.!?])\s+(?=[A-Z])/);
  return sentences.slice(0, maxSentences).join(" ").split(DECIMAL_MARKER).join(".").trim();
}

// Shared by enrichSpecies (below) and species/routes.ts's gallery-backfill branch for
// already-enriched species that predate the iNaturalist gallery source. iNaturalist-only —
// see this file's top comment for why there is deliberately no Wikipedia/Commons fallback
// when a species has no iNaturalist gallery photos.
export async function fetchAnyGallery(species: {
  id: string;
  scientific_name: string;
  reference_photo: string | null;
}): Promise<EnrichmentResult["gallery"]> {
  const taxon = await fetchINaturalistTaxon(species.scientific_name);
  if (!taxon) return [];
  return (await fetchINaturalistTaxonDetail(taxon.id, species.reference_photo, species.id)).gallery;
}

export async function enrichSpecies(species: {
  id: string;
  scientific_name: string;
}): Promise<EnrichmentResult> {
  const taxon = await fetchINaturalistTaxon(species.scientific_name);
  const inat = taxon?.defaultPhoto ? toGalleryPhoto(taxon.defaultPhoto) : null;
  let referencePhoto = inat?.photoUrl ?? null;
  let referenceCredit = inat?.credit ?? null;
  let referenceLicense = inat?.license ?? null;

  // Gallery sources from iNaturalist's own taxon_photos — fast, one request, no rate limiting
  // observed. iNaturalist-only: see this file's top comment for why there is deliberately no
  // Wikipedia/Commons fallback for a species with no iNaturalist photos.
  let gallery: EnrichmentResult["gallery"] = [];
  let inatWikipediaSummary: string | null = null;
  let inatWikipediaUrl: string | null = null;
  if (taxon) {
    const detail = await fetchINaturalistTaxonDetail(taxon.id, inat?.photoUrl ?? null, species.id);
    gallery = detail.gallery;
    inatWikipediaSummary = detail.wikipediaSummary;
    inatWikipediaUrl = detail.wikipediaUrl;
  }

  let referenceDisplayPath: string | null = null;
  let referenceThumbPath: string | null = null;
  if (referencePhoto) {
    const cached = await downloadAndCacheImage(referencePhoto, species.id);
    referenceDisplayPath = cached?.displayPath ?? null;
    referenceThumbPath = cached?.thumbPath ?? null;
  } else if (gallery.length > 0) {
    // iNaturalist's taxon record does not always have a "default_photo" flagged even when
    // its photo pool (taxon_photos, what the gallery draws from) has real entries — for
    // example, Common Minke Whale had 6 cached gallery photos but an empty main photo. This
    // is a curator-flag quirk, not an absence of any photo. Borrowing the first gallery
    // photo as the main one (already downloaded/cached above, no extra fetch) means a
    // species is only ever left with a blank main photo when there is truly nothing
    // anywhere, not just a missing default-photo flag.
    const [first, ...rest] = gallery;
    referencePhoto = first.photoUrl;
    referenceCredit = first.credit;
    referenceLicense = first.license;
    referenceDisplayPath = first.displayPath;
    referenceThumbPath = first.thumbPath;
    gallery = rest;
  }

  // iNaturalist-only: no direct Wikipedia fallback for the description/habitat text. A
  // species with no iNaturalist summary just gets no description, rather than paying for one
  // with a direct Wikipedia call — see this file's top comment for why.
  const description: string | null = inatWikipediaSummary;
  const descriptionCredit: string | null = inatWikipediaSummary ? "Wikipedia contributors (CC BY-SA), via iNaturalist" : null;
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
    gallery,
  };
}

/** Shared by the lazy on-view path (species/routes.ts) and the overnight eager
 *  enrich-all-species script — one write path so the two never drift apart. */
export async function persistEnrichment(speciesId: string, enrichment: EnrichmentResult): Promise<void> {
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
    ],
  );
  await persistGallery(speciesId, enrichment.gallery);
}

export async function persistGallery(speciesId: string, gallery: EnrichmentResult["gallery"]): Promise<void> {
  for (const photo of gallery) {
    await pool.query(
      `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, sort_order, display_path, thumb_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (species_id, photo_url) DO UPDATE SET
         display_path = EXCLUDED.display_path, thumb_path = EXCLUDED.thumb_path`,
      [speciesId, photo.photoUrl, photo.credit, photo.license, photo.sortOrder, photo.displayPath, photo.thumbPath],
    );
  }
}

// Shared by both gallery-backfill call sites (species/routes.ts's lazy backfill branch and
// backfill-missing-galleries.ts) — same fix as enrichSpecies' own inline version: a species
// reaching either of these paths might have no main photo yet for the same reason
// (iNaturalist's taxon record lacking a flagged default_photo despite having real
// taxon_photos) — without this, gallery-backfilling such a species would reproduce the same
// bug rather than fix it.
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
}
