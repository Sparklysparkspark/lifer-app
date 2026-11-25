// iNaturalist calls for lists, all through the shared client (lib/http.ts): one paced queue per
// host, Retry-After honoured, a 429 holding every caller. A list is fetched as a list
// (observations/species_counts, 500 species a page), never one lookup per species.
import { holdHost, httpFetch } from "@lifer/core/lib/http.js";
import { isPublishableLicense, normalizeLicense } from "@lifer/core/species/licensePolicy.js";
import { titleCaseCommonName } from "../otherTaxaSpecies.js";

export const INAT_V1 = "https://api.inaturalist.org/v1";
export const PER_PAGE = 500;
/** Species added per batch; a bigger list carries on in later batches (decision 1). */
export const LIST_SIZE_CAP = 5000;
export const PAGES_PER_BATCH = LIST_SIZE_CAP / PER_PAGE;
const WEEK_MS = 7 * 24 * 60 * 60_000;
// After a 403 every iNaturalist caller in the process waits, as after a 429.
const REFUSED_HOLD_MS = 30 * 60_000;

export type InatFailure = "offline" | "rate_limited" | "refused" | "failed";

export class InatUnavailableError extends Error {
  constructor(readonly code: InatFailure) {
    super(`iNaturalist unavailable: ${code}`);
    this.name = "InatUnavailableError";
  }
}

export interface ListQuery {
  taxonId: number;
  placeId: number;
  nativeOnly: boolean;
}

export interface ListSpecies {
  taxonId: number;
  scientificName: string;
  commonName: string | null;
  iconicTaxon: string | null;
  /** Research Grade observations in the place. */
  count: number;
  establishmentMeans: string | null;
  /** Only photos with a licence that isn't "all rights reserved" (licensePolicy.ts). */
  photo: { url: string; credit: string; license: string } | null;
}

export interface SpeciesCountsPage {
  total: number;
  species: ListSpecies[];
}

export function speciesCountsUrl(q: ListQuery, page: number, perPage = PER_PAGE): string {
  const params = new URLSearchParams({
    taxon_id: String(q.taxonId),
    place_id: String(q.placeId),
    quality_grade: "research",
    verifiable: "true",
    rank: "species",
    locale: "en",
    per_page: String(perPage),
    page: String(page),
  });
  if (q.nativeOnly) params.set("native", "true");
  return `${INAT_V1}/observations/species_counts?${params}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Throws on a body of the wrong shape, so an error page is never read as an empty list. */
export function parseSpeciesCounts(body: unknown): SpeciesCountsPage {
  if (!isRecord(body) || typeof body.total_results !== "number" || !Array.isArray(body.results))
    throw new Error("Unexpected iNaturalist species_counts response");
  const species: ListSpecies[] = [];
  for (const r of body.results) {
    const t = isRecord(r) && isRecord(r.taxon) ? r.taxon : null;
    if (!t || typeof t.id !== "number" || !str(t.name) || t.rank !== "species") continue;
    const em = isRecord(t.establishment_means) ? str(t.establishment_means.establishment_means) : null;
    const p = isRecord(t.default_photo) ? t.default_photo : null;
    const license = p && str(p.license_code) ? normalizeLicense(p.license_code as string) : null;
    const common = str(t.preferred_common_name);
    species.push({
      taxonId: t.id,
      scientificName: (t.name as string).trim(),
      commonName: common ? titleCaseCommonName(common) : null,
      iconicTaxon: str(t.iconic_taxon_name),
      count:
        typeof (r as Record<string, unknown>).count === "number" ? ((r as Record<string, unknown>).count as number) : 0,
      establishmentMeans: em ?? str(t.preferred_establishment_means),
      photo:
        p && str(p.medium_url) && license && isPublishableLicense(license)
          ? { url: p.medium_url as string, credit: str(p.attribution) ?? "iNaturalist", license }
          : null,
    });
  }
  return { total: body.total_results, species };
}

/** A JSON answer from iNaturalist, or InatUnavailableError saying why not. `cache` keeps it a week. */
export async function inatJson(
  url: string,
  opts: { signal?: AbortSignal; cache?: boolean; maxRetries?: number } = {},
): Promise<unknown> {
  let res: Response;
  try {
    res = await httpFetch(url, {
      signal: opts.signal,
      maxRetries: opts.maxRetries ?? 3,
      timeoutMs: 30_000,
      cache: opts.cache ? { table: "inat_response_cache", maxAgeMs: WEEK_MS } : undefined,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new InatUnavailableError("offline");
  }
  if (res.ok) return res.json();
  await res.body?.cancel().catch(() => {});
  if (res.status === 429) throw new InatUnavailableError("rate_limited");
  if (res.status === 403) {
    holdHost(new URL(url).host, REFUSED_HOLD_MS);
    throw new InatUnavailableError("refused");
  }
  throw new InatUnavailableError("failed");
}

export async function fetchSpeciesCountsPage(q: ListQuery, page: number, signal?: AbortSignal) {
  return parseSpeciesCounts(await inatJson(speciesCountsUrl(q, page), { signal }));
}

/** The count and the most observed examples, from one cached call. */
export async function previewList(q: ListQuery, examples = 6): Promise<SpeciesCountsPage> {
  return parseSpeciesCounts(await inatJson(speciesCountsUrl(q, 1, examples), { cache: true, maxRetries: 0 }));
}

export interface TaxonHit {
  taxonId: number;
  name: string;
  rank: string | null;
  commonName: string | null;
  iconicTaxon: string | null;
  observationsCount: number | null;
  thumbnailUrl: string | null;
}

export async function searchTaxa(q: string): Promise<TaxonHit[]> {
  const params = new URLSearchParams({ q, is_active: "true", locale: "en", per_page: "10" });
  const body = await inatJson(`${INAT_V1}/taxa/autocomplete?${params}`, { cache: true, maxRetries: 0 });
  const results = isRecord(body) && Array.isArray(body.results) ? body.results : [];
  return results.flatMap((t) =>
    isRecord(t) && typeof t.id === "number" && str(t.name)
      ? [
          {
            taxonId: t.id,
            name: t.name as string,
            rank: str(t.rank),
            commonName: str(t.preferred_common_name) ? titleCaseCommonName(t.preferred_common_name as string) : null,
            iconicTaxon: str(t.iconic_taxon_name),
            observationsCount: typeof t.observations_count === "number" ? t.observations_count : null,
            thumbnailUrl: isRecord(t.default_photo) ? str(t.default_photo.square_url) : null,
          },
        ]
      : [],
  );
}

export interface PlaceHit {
  placeId: number;
  name: string;
  displayName: string;
  adminLevel: number | null;
}

export async function searchPlaces(q: string): Promise<PlaceHit[]> {
  const params = new URLSearchParams({ q, per_page: "10" });
  const body = await inatJson(`${INAT_V1}/places/autocomplete?${params}`, { cache: true, maxRetries: 0 });
  const results = isRecord(body) && Array.isArray(body.results) ? body.results : [];
  return results.flatMap((p) =>
    isRecord(p) && typeof p.id === "number" && str(p.name)
      ? [
          {
            placeId: p.id,
            name: p.name as string,
            displayName: str(p.display_name) ?? (p.name as string),
            adminLevel: typeof p.admin_level === "number" ? p.admin_level : null,
          },
        ]
      : [],
  );
}
