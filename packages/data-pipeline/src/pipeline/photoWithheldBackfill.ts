// Fills in species.photo_withheld (migration 123) for species that lost their photo, or were found
// with nothing publishable, before the column existed. A species is marked when iNaturalist has
// photos for it and none of them may be published (licensePolicy.ts), which is exactly when
// installs should fetch one for personal viewing (apps/api/src/species/withheldPhotos.ts).
//
// Decided from the iNaturalist responses enrichment already cached (inat_response_cache, keyed by
// URL: lazyEnrich.ts's inatTaxonSearchUrl and inatTaxonUrl), so most species cost no request at
// all. Only species with no usable cached response are looked up, one at a time at lazyEnrich's
// pace, which caches the answer the same way; the classification then reads that.
//
// Only photoless species on a checklist or sea zone are looked at: installs only fetch photos for
// species in their packs. It only ever sets the flag; clearing it is the policy's job.
import type { Pool } from "pg";
import { isPublishableLicense, normalizeLicense } from "@lifer/core/species/licensePolicy.js";
import { inatTaxonSearchUrl, inatTaxonUrl } from "@lifer/core/species/lazyEnrich.js";
import { RateLimitBreaker } from "./rateLimitBreaker.js";

interface CachedPhoto {
  license_code?: string | null;
}
interface CachedTaxon {
  id: number;
  name?: string;
  default_photo?: CachedPhoto | null;
  taxon_photos?: Array<{ photo?: CachedPhoto | null }>;
}

export type PhotoEvidence = "withheld" | "publishable" | "none" | "unknown";

const licenseOf = (p: CachedPhoto) => (p.license_code ? normalizeLicense(p.license_code) : "all-rights-reserved");

function parseResults(response: string | undefined): CachedTaxon[] | null {
  if (response === undefined) return null;
  try {
    const parsed = JSON.parse(response) as { results?: CachedTaxon[] };
    return Array.isArray(parsed.results) ? parsed.results : null;
  } catch {
    return null;
  }
}

/** What the cached responses say about a species' photos. `search` is its taxa search response,
 *  `details` the taxon records (/taxa/{id}) cached for its taxon ids. "none" only when a taxon
 *  record says so outright: a search result's default_photo isn't always set when photos exist. */
export function classifyPhotoEvidence(
  scientificName: string,
  search: string | undefined,
  details: Array<string | undefined>,
): PhotoEvidence {
  const photos: CachedPhoto[] = [];
  let recordSeen = false;
  const match = parseResults(search)?.find((r) => r.name?.toLowerCase() === scientificName.toLowerCase());
  if (match?.default_photo) photos.push(match.default_photo);
  for (const detail of details) {
    const taxon = parseResults(detail)?.[0];
    if (!taxon) continue;
    recordSeen = true;
    if (taxon.default_photo) photos.push(taxon.default_photo);
    for (const tp of taxon.taxon_photos ?? []) if (tp.photo) photos.push(tp.photo);
  }
  if (photos.length === 0) return recordSeen ? "none" : "unknown";
  return photos.some((p) => isPublishableLicense(licenseOf(p))) ? "publishable" : "withheld";
}

/** The taxon ids worth looking up a cached record for: the catalog's and the search's exact match. */
function taxonIds(scientificName: string, inatTaxonId: number | null, search: string | undefined): number[] {
  const match = parseResults(search)?.find((r) => r.name?.toLowerCase() === scientificName.toLowerCase());
  return [...new Set([inatTaxonId, match?.id].filter((id): id is number => typeof id === "number"))];
}

interface Candidate {
  id: string;
  scientific_name: string;
  inat_taxon_id: number | null;
}

async function cachedResponses(db: Pool, urls: string[]): Promise<Map<string, string>> {
  const res = await db.query<{ url: string; response: string }>(
    `SELECT url, response FROM inat_response_cache WHERE url = ANY($1)`,
    [urls],
  );
  return new Map(res.rows.map((r) => [r.url, r.response]));
}

async function classifyFromCache(db: Pool, rows: Candidate[]): Promise<Map<string, PhotoEvidence>> {
  const searches = await cachedResponses(
    db,
    rows.map((r) => inatTaxonSearchUrl(r.scientific_name)),
  );
  const idsBySpecies = new Map(
    rows.map((r) => [
      r.id,
      taxonIds(r.scientific_name, r.inat_taxon_id, searches.get(inatTaxonSearchUrl(r.scientific_name))),
    ]),
  );
  const details = await cachedResponses(db, [...new Set([...idsBySpecies.values()].flat())].map(inatTaxonUrl));
  return new Map(
    rows.map((r) => [
      r.id,
      classifyPhotoEvidence(
        r.scientific_name,
        searches.get(inatTaxonSearchUrl(r.scientific_name)),
        idsBySpecies.get(r.id)!.map((id) => details.get(inatTaxonUrl(id))),
      ),
    ]),
  );
}

export interface BackfillOptions {
  /** Look up species with no usable cached response (the default). */
  network: boolean;
  /** Count only, write nothing (lookups still fill the response cache). */
  dryRun: boolean;
  /** Fetches the species' search and taxon record into inat_response_cache; resolves to whether
   *  it was rate-limited. lazyEnrich-backed in the script, faked in tests. */
  lookup: (species: { scientific_name: string; inat_taxon_id: number | null }) => Promise<{ rateLimited: boolean }>;
  log?: (message: string) => void;
}

export interface BackfillResult {
  candidates: number;
  withheld: number;
  publishable: number;
  none: number;
  unknown: number;
  lookedUp: number;
  marked: number;
  stoppedByRateLimit: boolean;
}

const CHUNK = 1000;

export async function backfillPhotoWithheld(db: Pool, options: BackfillOptions): Promise<BackfillResult> {
  const log = options.log ?? (() => {});
  const candidates = (
    await db.query<Candidate>(
      `SELECT s.id, s.scientific_name, s.inat_taxon_id FROM species s
        WHERE s.reference_photo IS NULL AND NOT s.photo_withheld AND NOT s.is_other_taxa
          AND (EXISTS (SELECT 1 FROM region_species rs WHERE rs.species_id = s.id)
               OR EXISTS (SELECT 1 FROM sea_zone_species z WHERE z.species_id = s.id))
        ORDER BY s.scientific_name`,
    )
  ).rows;
  log(`${candidates.length} listed species without a photo and not marked yet`);

  const evidence = new Map<string, PhotoEvidence>();
  for (let i = 0; i < candidates.length; i += CHUNK) {
    for (const [id, e] of await classifyFromCache(db, candidates.slice(i, i + CHUNK))) evidence.set(id, e);
  }
  const unknown = candidates.filter((c) => evidence.get(c.id) === "unknown");
  log(`${candidates.length - unknown.length} decided from cached iNaturalist responses, ${unknown.length} without one`);

  let lookedUp = 0;
  let stoppedByRateLimit = false;
  if (options.network && unknown.length > 0) {
    const breaker = new RateLimitBreaker();
    for (const species of unknown) {
      const { rateLimited } = await options.lookup(species);
      if (breaker.record(rateLimited)) {
        stoppedByRateLimit = true;
        log("iNaturalist is refusing most requests; stopping lookups (run again later to finish)");
        break;
      }
      if (rateLimited) continue;
      lookedUp++;
      evidence.set(species.id, (await classifyFromCache(db, [species])).get(species.id)!);
      if (lookedUp % 250 === 0) log(`${lookedUp}/${unknown.length} looked up`);
    }
  }

  const withheldIds = candidates.filter((c) => evidence.get(c.id) === "withheld").map((c) => c.id);
  const count = (e: PhotoEvidence) => candidates.filter((c) => evidence.get(c.id) === e).length;
  let marked = 0;
  if (!options.dryRun && withheldIds.length > 0) {
    const res = await db.query(
      `UPDATE species SET photo_withheld = true WHERE id = ANY($1) AND reference_photo IS NULL`,
      [withheldIds],
    );
    marked = res.rowCount ?? 0;
  }
  return {
    candidates: candidates.length,
    withheld: withheldIds.length,
    publishable: count("publishable"),
    none: count("none"),
    unknown: count("unknown"),
    lookedUp,
    marked,
    stoppedByRateLimit,
  };
}
