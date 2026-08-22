// On-demand species enrichment — reference photo (iNaturalist, then Wikimedia Commons
// fallback), a one-sentence Wikipedia ID blurb, and the reference-photo gallery, all fetched
// together the first time a species detail page is opened, instead of the full ~11,000
// species backbone doing this eagerly (estimated 8+ hours for species that may never be
// viewed). Ported from packages/data-pipeline's fetch-reference-photos.ts
// / fetch-commons-photo.ts / fetch-wikipedia-summary.ts / fetch-wikipedia-media.ts (not
// imported — see licensePolicy.ts for why data-pipeline's own runtime deps shouldn't leak
// into the live API), consolidated into one pass with one "already tried" flag
// (species.enriched_at) instead of three separate ones.
import { isLicenseAllowed, normalizeLicense } from "./licensePolicy.js";
import { generateReferenceDerivatives } from "../uploads/image.js";
import { pool } from "../db.js";

const INAT_API = "https://api.inaturalist.org/v1";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const MEDIA_LIST_API = "https://en.wikipedia.org/api/rest_v1/page/media-list/";
const MAX_GALLERY_PHOTOS = 6;
const PHOTO_EXTENSIONS = /\.(jpe?g|png)$/i;
const EXCLUDE_PATTERNS = /map|iucn|status|logo|icon|diagram|distribution|range|locator|plate|sound|chart/i;
const DESCRIPTION_HEADINGS = ["description", "identification", "appearance"];
// Habitat/range info was never surfaced even though it is usually present in the same
// Wikipedia article text already downloaded; this was a self-imposed gap (only
// DESCRIPTION_HEADINGS were ever searched for), not a data limitation.
const HABITAT_HEADINGS = ["habitat", "distribution", "range", "habitat and distribution", "distribution and habitat", "ecology and habitat", "habitat and range", "range and habitat"];
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

// This needs to be shared, module-level state rather than purely per-request backoff:
// Wikimedia's upload CDN sends a real `Retry-After: 600` (10 minutes) on a 429, and
// re-hitting the server again mid-cooldown appears to extend the ban rather than clear it.
// This gate makes every caller, across this whole process, wait out a known ban before
// attempting anything new, and enforces a steady per-request pace once clear so a burst of
// concurrent calls can't immediately re-trigger it the moment the ban lifts.
let bannedUntil = 0;
// A true mutex, not just staggered start times: spacing out only when each request starts
// (e.g. reserving a slot 1.1s apart) still allows a slow-to-respond request to be in flight
// when the next one starts, making multiple requests genuinely concurrent against Wikimedia
// even though they began at staggered times — which is enough on its own to trip the ban.
// Chaining onto this promise means the next request can't begin until the previous one's
// fetch has fully resolved (success or failure) and the minimum interval has passed since
// then — at most one request to Wikimedia in flight at any instant, process-wide.
let queue: Promise<void> = Promise.resolve();
let lastCompletedAt = 0;
// This needs to be much larger than a typical "polite API" convention would suggest: even a
// true one-at-a-time mutex at 3s intervals still drew a fresh 600s hard ban after roughly
// every ~4 successful requests, so the tolerance window here is much tighter than
// documented. This value trades throughput for actually finishing an unattended, multi-day
// crawl instead of spending most of each cycle sitting out repeat bans.
const MIN_INTERVAL_MS = 75_000;

function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(bannedUntil - now, lastCompletedAt + MIN_INTERVAL_MS - now, 0);
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    try {
      return await fn();
    } finally {
      lastCompletedAt = Date.now();
    }
  });
  // Swallow the outcome for the queue's own chain (a rejection must not break the next
  // caller's turn) — the real result/error still propagates to whoever called runSerialized.
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// fetchWithRetry (and therefore the shared Wikimedia mutex/pacing above) previously applied
// to every image download regardless of host, including iNaturalist's S3 bucket, which
// shows no rate-limiting. That meant the majority of species whose photo comes from
// iNaturalist were also stuck behind Wikimedia's per-request pace and its 10-minute bans for
// no reason, stalling the enrichment job entirely even while running.
//
// en.wikipedia.org's own API is not rate-limited in practice; it had been added to this set
// defensively without verification, and since most species have a Wikipedia article, that
// alone kept the whole pipeline choked. commons.wikimedia.org's API does rate-limit for
// real, so only upload.wikimedia.org and commons.wikimedia.org stay gated behind the mutex;
// en.wikipedia.org and everything else (iNaturalist, etc.) get a plain per-request
// retry-on-429 with no artificial pacing.
const WIKIMEDIA_HOSTS = new Set(["upload.wikimedia.org", "commons.wikimedia.org"]);

export async function fetchWithRetry(url: string): Promise<Response> {
  const isWikimedia = WIKIMEDIA_HOSTS.has(new URL(url).host);

  for (let attempt = 0; attempt <= 3; attempt++) {
    const doFetch = () => fetch(url, { headers: { "User-Agent": "lifer-api/0.1 (personal project)" } });
    const res = isWikimedia ? await runSerialized(doFetch) : await doFetch();
    if (res.status !== 429) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
    if (isWikimedia) bannedUntil = Math.max(bannedUntil, Date.now() + delayMs);
    console.error(`[lazyEnrich] 429 from ${new URL(url).host}, backing off ${Math.round(delayMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return fetch(url);
}

async function fetchCommonsFileMetadata(filename: string): Promise<{ photoUrl: string; credit: string; license: string } | null> {
  const url =
    `${COMMONS_API}?action=query&titles=${encodeURIComponent(`File:${filename}`)}` +
    `&prop=imageinfo&iiprop=extmetadata|url&format=json&origin=*`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    query: { pages: Record<string, { imageinfo?: Array<{ url: string; extmetadata: Record<string, { value: string }> }> }> };
  };
  const info = Object.values(data.query.pages)[0]?.imageinfo?.[0];
  if (!info) return null;

  const rawLicense = info.extmetadata.License?.value ?? info.extmetadata.LicenseShortName?.value;
  const license = rawLicense ? normalizeLicense(rawLicense) : null;
  if (!license || !isLicenseAllowed(license)) return null;

  const artist = info.extmetadata.Artist?.value ? info.extmetadata.Artist.value.replace(/<[^>]+>/g, "").trim() : "Unknown";
  return {
    photoUrl: info.url,
    credit: `${artist}, via Wikimedia Commons (${info.extmetadata.LicenseShortName?.value ?? license})`,
    license,
  };
}

/** commonsImageUrl looks like "http://commons.wikimedia.org/wiki/Special:FilePath/Foo%20bar.jpg". */
function filenameFromCommonsUrl(commonsImageUrl: string): string | null {
  const m = commonsImageUrl.match(/Special:FilePath\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
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

function toGalleryPhoto(photo: INaturalistPhoto): { photoUrl: string; credit: string; license: string } {
  const license = photo.license_code ? normalizeLicense(photo.license_code) : "all-rights-reserved";
  return { photoUrl: photo.medium_url, credit: photo.attribution, license };
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
    const res = await fetch(url);
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

export async function fetchINaturalistTaxon(
  scientificName: string,
): Promise<{ id: number; defaultPhoto: INaturalistPhoto | null } | null> {
  const url = `${INAT_API}/taxa?q=${encodeURIComponent(scientificName)}&rank=species&is_active=true&per_page=10`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    results: Array<{ id: number; name: string; default_photo: INaturalistPhoto | null }>;
  };
  const exactMatch = data.results.find((r) => r.name.toLowerCase() === scientificName.toLowerCase());
  if (exactMatch) return { id: exactMatch.id, defaultPhoto: exactMatch.default_photo };
  return findReclassifiedTaxon(scientificName, data.results);
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

function splitSections(extract: string): Map<string, string> {
  const sections = new Map<string, string>();
  const headingPattern = /^==+\s*(.+?)\s*==+$/gm;
  let lastIndex = 0;
  let lastHeading = "";
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(extract))) {
    sections.set(lastHeading, extract.slice(lastIndex, match.index).trim());
    lastHeading = match[1].trim().toLowerCase();
    lastIndex = headingPattern.lastIndex;
  }
  sections.set(lastHeading, extract.slice(lastIndex).trim());
  return sections;
}

export async function fetchWikipediaBlurb(
  wikipediaTitle: string,
): Promise<{
  description: string;
  descriptionCredit: string;
  descriptionSourceUrl: string;
  habitatDescription: string | null;
} | null> {
  const url =
    `${WIKIPEDIA_API}?action=query&prop=extracts&explaintext=1&redirects=1&format=json` +
    `&titles=${encodeURIComponent(wikipediaTitle)}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    query?: { pages: Record<string, { title?: string; extract?: string; missing?: string }> };
  };
  const page = data.query ? Object.values(data.query.pages)[0] : undefined;
  if (!page?.extract || page.missing !== undefined) return null;

  const sections = splitSections(page.extract);
  const descriptionHeading = DESCRIPTION_HEADINGS.find((h) => sections.has(h) && sections.get(h));
  const body = descriptionHeading ? sections.get(descriptionHeading)! : sections.get("") ?? page.extract;
  const canonicalTitle = page.title ?? wikipediaTitle;

  // Habitat/range info was never surfaced even though it's usually present in the same
  // article, one section over from "description." Genuinely absent (no matching heading)
  // for plenty of species — that's a real, honest null, not a fallback guess.
  const habitatHeading = HABITAT_HEADINGS.find((h) => sections.has(h) && sections.get(h));
  const habitatDescription = habitatHeading ? truncateToSentences(sections.get(habitatHeading)!, 4) : null;

  return {
    // 4 sentences gives real room without turning into a full article dump — 2 was too
    // limiting for plenty of species.
    description: truncateToSentences(body, 4),
    descriptionCredit: "Wikipedia contributors (CC BY-SA)",
    descriptionSourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(canonicalTitle.replace(/ /g, "_"))}`,
    habitatDescription,
  };
}

export async function fetchGallery(wikipediaTitle: string, speciesId: string): Promise<EnrichmentResult["gallery"]> {
  const url = MEDIA_LIST_API + encodeURIComponent(wikipediaTitle.replace(/ /g, "_"));
  const res = await fetchWithRetry(url);
  if (!res.ok) return [];

  const data = (await res.json()) as { items?: Array<{ title?: string; type?: string }> };
  const candidates = (data.items ?? [])
    .filter((item) => item.type === "image" && item.title)
    .map((item) => item.title!.replace(/^File:/, ""))
    .filter((filename) => PHOTO_EXTENSIONS.test(filename) && !EXCLUDE_PATTERNS.test(filename))
    .slice(0, MAX_GALLERY_PHOTOS);

  const results: EnrichmentResult["gallery"] = [];
  for (const filename of candidates) {
    const photo = await fetchCommonsFileMetadata(filename);
    if (photo) {
      // Keyed by species id + position rather than a fresh uuid — stable across re-runs
      // (an already-cached gallery photo's files get overwritten in place, not orphaned
      // under a new random name each time enrichment happens to re-run for this species).
      const cached = await downloadAndCacheImage(photo.photoUrl, `${speciesId}-gallery-${results.length}`);
      results.push({ ...photo, sortOrder: results.length, displayPath: cached?.displayPath ?? null, thumbPath: cached?.thumbPath ?? null });
    }
  }
  return results;
}

// Shared by enrichSpecies (below) and species/routes.ts's gallery-backfill branch for
// already-enriched species that predate the iNaturalist gallery source — one place for
// "iNaturalist gallery first, Wikipedia/Commons only if that's empty" so the two paths can't
// drift apart.
export async function fetchAnyGallery(species: {
  id: string;
  scientific_name: string;
  wikipedia_title: string | null;
  reference_photo: string | null;
}): Promise<EnrichmentResult["gallery"]> {
  const taxon = await fetchINaturalistTaxon(species.scientific_name);
  let gallery: EnrichmentResult["gallery"] = [];
  if (taxon) {
    gallery = (await fetchINaturalistTaxonDetail(taxon.id, species.reference_photo, species.id)).gallery;
  }
  if (gallery.length === 0 && species.wikipedia_title) {
    gallery = await fetchGallery(species.wikipedia_title, species.id);
  }
  return gallery;
}

export async function enrichSpecies(
  species: {
    id: string;
    scientific_name: string;
    wikipedia_title: string | null;
    commons_image: string | null;
  },
  opts: { skipGallery?: boolean } = {},
): Promise<EnrichmentResult> {
  const taxon = await fetchINaturalistTaxon(species.scientific_name);
  const inat = taxon?.defaultPhoto ? toGalleryPhoto(taxon.defaultPhoto) : null;
  let referencePhoto = inat?.photoUrl ?? null;
  let referenceCredit = inat?.credit ?? null;
  let referenceLicense = inat?.license ?? null;

  if (!referencePhoto && species.commons_image) {
    const filename = filenameFromCommonsUrl(species.commons_image);
    const commons = filename ? await fetchCommonsFileMetadata(filename) : null;
    if (commons) {
      referencePhoto = commons.photoUrl;
      referenceCredit = commons.credit;
      referenceLicense = commons.license;
    }
  }

  // Gallery now sources primarily from iNaturalist's own taxon_photos (fast, one request,
  // no rate limiting observed) instead of the old Wikipedia-media-list + per-photo Commons
  // approach — this was the real bottleneck that used to force the bulk overnight pass to
  // skip galleries entirely (each Commons-sourced photo needed its own 75s-spaced request).
  // The slow Wikipedia/Commons path (inside fetchAnyGallery, gated by opts.skipGallery in
  // the bulk pass) now only runs as a fallback for the rare species with no iNaturalist
  // photos at all — no realistic volume concern there since it should rarely trigger.
  let gallery: EnrichmentResult["gallery"] = [];
  let inatWikipediaSummary: string | null = null;
  let inatWikipediaUrl: string | null = null;
  if (taxon) {
    const detail = await fetchINaturalistTaxonDetail(taxon.id, inat?.photoUrl ?? null, species.id);
    gallery = detail.gallery;
    inatWikipediaSummary = detail.wikipediaSummary;
    inatWikipediaUrl = detail.wikipediaUrl;
  }
  if (gallery.length === 0 && species.wikipedia_title && !opts.skipGallery) {
    gallery = await fetchGallery(species.wikipedia_title, species.id);
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

  let description: string | null = inatWikipediaSummary;
  let descriptionCredit: string | null = inatWikipediaSummary ? "Wikipedia contributors (CC BY-SA), via iNaturalist" : null;
  let descriptionSourceUrl: string | null = inatWikipediaSummary ? inatWikipediaUrl : null;
  let habitatDescription: string | null = null;

  // iNaturalist is preferred exclusively unless it has no entry for a species. This call
  // used to run unconditionally whenever wikipedia_title existed, specifically to get
  // habitat text (which iNaturalist's own intro-only summary never carries) — which quietly
  // reintroduced a direct Wikipedia call for nearly every species and defeated the point of
  // preferring iNaturalist. It now only runs when iNaturalist had no description at all;
  // species with a real iNaturalist summary get no habitat text rather than paying for one
  // with a Wikipedia call.
  if (species.wikipedia_title && !description) {
    const blurb = await fetchWikipediaBlurb(species.wikipedia_title);
    description = blurb?.description ?? null;
    descriptionCredit = blurb?.descriptionCredit ?? null;
    descriptionSourceUrl = blurb?.descriptionSourceUrl ?? null;
    habitatDescription = blurb?.habitatDescription ?? null;
  }

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
