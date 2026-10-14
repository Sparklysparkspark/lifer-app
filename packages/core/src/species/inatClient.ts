// iNaturalist lookups for species enrichment, and the reference-image downloads that go with them.
// Every call goes through the shared HTTP client (lib/http.ts): paced per host, retried on 429,
// and iNaturalist's JSON answers cached in inat_response_cache. No direct Wikipedia or Commons
// calls (Commons rate-limits hard).
import { generateReferenceDerivatives } from "../uploads/image.js";
import { log } from "../lib/log.js";
import {
  evictCachedResponse,
  httpFetch,
  INAT_MIN_HOST_INTERVAL_MS,
  type HttpOptions,
  type ResponseCacheOptions,
} from "../lib/http.js";

export const INAT_API = "https://api.inaturalist.org/v1";

// The URLs of the two lookups enrichment starts with, which are also their inat_response_cache
// keys (the photo-withheld backfill reads them from there).
export const inatTaxonSearchUrl = (scientificName: string): string =>
  `${INAT_API}/taxa?q=${encodeURIComponent(scientificName)}&rank=species&is_active=true&per_page=10`;
export const inatTaxonUrl = (taxonId: number): string => `${INAT_API}/taxa/${taxonId}`;

// Thrown when iNaturalist is still throttling after every retry. Callers must not set
// enriched_at on it, which would record "no photo" for a species that may have one.
export class PersistentRateLimitError extends Error {}

// Only iNaturalist's JSON API responses are cached, never image downloads.
const CACHEABLE_HOSTS = new Set(["api.inaturalist.org", "www.inaturalist.org"]);

// The cache exists for pipeline builds, which read it however old. An install reading it for
// on-view enrichment refetches after 90 days, so it still sees iNaturalist's taxon changes.
export const INAT_RESPONSE_CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
let inatResponseCacheMaxAgeMs: number | null = INAT_RESPONSE_CACHE_MAX_AGE_MS;

/** Pipeline scripts call this with null to read cached responses whatever their age. */
export function setInatResponseCacheMaxAge(maxAgeMs: number | null): void {
  inatResponseCacheMaxAgeMs = maxAgeMs;
}

function inatCache(): ResponseCacheOptions {
  return { table: "inat_response_cache", maxAgeMs: inatResponseCacheMaxAgeMs };
}

// Every enrichment request, image downloads included, is paced and gets the same 429 backoff.
const ENRICHMENT_FETCH: HttpOptions = { paceMs: INAT_MIN_HOST_INTERVAL_MS, timeoutMs: 15_000, maxRetries: 4 };

/** A GET for enrichment: paced, retried, and cached for iNaturalist's API hosts. */
export async function inatFetch(url: string): Promise<Response> {
  const cache = CACHEABLE_HOSTS.has(new URL(url).host) ? inatCache() : undefined;
  const res = await httpFetch(url, { ...ENRICHMENT_FETCH, cache });
  // Still 429 means "try again later", not "nothing there", so it is thrown.
  if (res.status === 429) {
    await res.body?.cancel().catch(() => {});
    throw new PersistentRateLimitError(`still rate-limited after retries: ${url}`);
  }
  return res;
}

// Lifer is personal use, so the species' default photo is used whatever its license, as viewing
// it on iNaturalist would show it.
export interface INaturalistPhoto {
  medium_url: string;
  license_code: string | null;
  attribution: string;
}

/** The fields of an iNaturalist taxon record (/v1/taxa/{ids}) that enrichment reads. */
export interface INaturalistTaxonRecord {
  id: number;
  name: string;
  rank?: string;
  default_photo?: INaturalistPhoto | null;
  taxon_photos?: Array<{ photo: INaturalistPhoto }>;
  wikipedia_summary?: string | null;
  wikipedia_url?: string | null;
}

interface INaturalistTaxonChange {
  status: string;
  input_taxa: Array<{ name: string }>;
  output_taxa: Array<{ id: number }>;
}

// Shape checks for the fields read, so an odd payload (an error page served as 200, a renamed
// field) fails loudly instead of being read as "no photo" and cached.
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isOptionalString = (v: unknown): boolean => v == null || typeof v === "string";

function isPhoto(v: unknown): v is INaturalistPhoto {
  return (
    isRecord(v) &&
    typeof v.medium_url === "string" &&
    isOptionalString(v.license_code) &&
    typeof v.attribution === "string"
  );
}

export function isTaxonRecord(v: unknown): v is INaturalistTaxonRecord {
  return (
    isRecord(v) &&
    typeof v.id === "number" &&
    typeof v.name === "string" &&
    isOptionalString(v.rank) &&
    (v.default_photo == null || isPhoto(v.default_photo)) &&
    (v.taxon_photos == null ||
      (Array.isArray(v.taxon_photos) && v.taxon_photos.every((tp) => isRecord(tp) && isPhoto(tp.photo)))) &&
    isOptionalString(v.wikipedia_summary) &&
    isOptionalString(v.wikipedia_url)
  );
}

export function isTaxaResponse(v: unknown): v is { results: INaturalistTaxonRecord[] } {
  return isRecord(v) && Array.isArray(v.results) && v.results.every(isTaxonRecord);
}

export function isTaxonChanges(v: unknown): v is INaturalistTaxonChange[] {
  return (
    Array.isArray(v) &&
    v.every(
      (c) =>
        isRecord(c) &&
        typeof c.status === "string" &&
        Array.isArray(c.input_taxa) &&
        c.input_taxa.every((t) => isRecord(t) && typeof t.name === "string") &&
        Array.isArray(c.output_taxa) &&
        c.output_taxa.every((t) => isRecord(t) && typeof t.id === "number"),
    )
  );
}

/** The parsed body, null when iNaturalist answered with an error status. A body of the wrong
 *  shape is dropped from the cache and thrown, so it's neither read as "nothing there" nor
 *  replayed from the cache. */
export async function fetchInatJson<T>(url: string, guard: (v: unknown) => v is T, what: string): Promise<T | null> {
  const res = await inatFetch(url);
  if (!res.ok) return null;
  const body: unknown = await res.json().catch(() => undefined);
  if (guard(body)) return body;
  await evictCachedResponse(inatCache(), url);
  throw new Error(`Unexpected iNaturalist ${what} response from ${url}`);
}

/** The first record of a /v1/taxa/{id} answer; undefined for an empty answer, null on an error status. */
export async function fetchTaxonRecord(taxonId: number): Promise<INaturalistTaxonRecord | undefined | null> {
  const data = await fetchInatJson(inatTaxonUrl(taxonId), isTaxaResponse, "taxon");
  return data ? data.results[0] : null;
}

// The first taxon photo, metadata only. default_photo isn't always flagged even when the taxon
// has photos, so callers that need one photo fall back to this.
export async function fetchFirstTaxonPhoto(taxonId: number): Promise<INaturalistPhoto | null> {
  return (await fetchTaxonRecord(taxonId))?.taxon_photos?.[0]?.photo ?? null;
}

type FoundTaxon = { id: number; defaultPhoto: INaturalistPhoto | null };

// iNaturalist's search ranks by relevance, so only an exact name match counts, or a candidate
// that a committed taxon change (taxon_changes.json) lists the original name as an input for.
// Never a guess by name similarity.
async function findReclassifiedTaxon(
  scientificName: string,
  candidates: INaturalistTaxonRecord[],
): Promise<FoundTaxon | null> {
  for (const candidate of candidates.slice(0, 5)) {
    const url = `https://www.inaturalist.org/taxon_changes.json?taxon_id=${candidate.id}`;
    const changes = await fetchInatJson(url, isTaxonChanges, "taxon change");
    if (!changes) continue;
    const documented = changes.some(
      (c) =>
        c.status === "committed" &&
        c.output_taxa.some((o) => o.id === candidate.id) &&
        c.input_taxa.some((i) => i.name.toLowerCase() === scientificName.toLowerCase()),
    );
    if (documented) return { id: candidate.id, defaultPhoto: candidate.default_photo ?? null };
  }
  return null;
}

// A species in a split taxonomy can be a subspecies on iNaturalist (Anas carolinensis is Anas
// crecca carolinensis), which a species-rank search never finds.
async function fetchINaturalistSubspecies(scientificName: string): Promise<FoundTaxon | null> {
  const url = `${INAT_API}/taxa?q=${encodeURIComponent(scientificName)}&is_active=true&per_page=10`;
  const data = await fetchInatJson(url, isTaxaResponse, "taxon search");
  if (!data) return null;
  const [genus, epithet] = scientificName.toLowerCase().split(" ");
  const exactMatch = data.results.find((r) => {
    const name = r.name.toLowerCase();
    return r.rank === "subspecies" && name.startsWith(`${genus} `) && name.endsWith(` ${epithet}`);
  });
  return exactMatch ? { id: exactMatch.id, defaultPhoto: exactMatch.default_photo ?? null } : null;
}

export async function fetchINaturalistTaxon(scientificName: string): Promise<FoundTaxon | null> {
  const data = await fetchInatJson(inatTaxonSearchUrl(scientificName), isTaxaResponse, "taxon search");
  if (!data) return null;
  const exactMatch = data.results.find((r) => r.name.toLowerCase() === scientificName.toLowerCase());
  if (exactMatch) return { id: exactMatch.id, defaultPhoto: exactMatch.default_photo ?? null };
  const reclassified = await findReclassifiedTaxon(scientificName, data.results);
  if (reclassified) return reclassified;
  return fetchINaturalistSubspecies(scientificName);
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

// Commons hands out image URLs with utm_ parameters, which make every request miss Wikimedia's CDN
// and hit the rate-limited origin. The stored URL keeps them; only the fetch drops them.
export function withoutTrackingParams(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (key.startsWith("utm_")) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url;
  }
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
    const res = await inatFetch(withoutTrackingParams(url));
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
