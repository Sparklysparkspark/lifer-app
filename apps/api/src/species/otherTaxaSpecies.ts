// Creating an Other Taxa species from its iNaturalist taxon, kept apart from the routes so
// lib/collectionState.ts can restore saved taxa without importing them.
import { pool } from "@lifer/core/db.js";
import {
  enrichSpecies,
  persistEnrichment,
  persistGalleryPromotingMainIfMissing,
} from "@lifer/core/species/lazyEnrich.js";
import { iucnCodeFromInatLevel, normalizeIucnStatus } from "@lifer/shared";
import { httpFetch } from "@lifer/core/lib/http.js";
import { log } from "@lifer/core/lib/log.js";

export const INAT_TAXA_API = "https://api.inaturalist.org/v1/taxa";
// Live lookups for a person waiting on them: the shared client's pacing and User-Agent, no retries.
export const LOOKUP = { timeoutMs: 15_000, maxRetries: 0 };
// iNaturalist's vernacular names are inconsistently cased; the rest of the catalog is title case.
export function titleCaseCommonName(name: string): string {
  return name.replace(/(^|[\s-])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

export async function resolveOrCreateOtherTaxaSpecies(
  inatTaxonId: number,
  { enrichLater = false }: { enrichLater?: boolean } = {},
): Promise<{ speciesId: string; scientificName: string }> {
  const existing = await pool.query<{ id: string; scientific_name: string }>(
    `SELECT id, scientific_name FROM species WHERE inat_taxon_id = $1 AND is_other_taxa = true`,
    [inatTaxonId],
  );
  if (existing.rows[0]) return { speciesId: existing.rows[0].id, scientificName: existing.rows[0].scientific_name };
  if (!Number.isSafeInteger(inatTaxonId) || inatTaxonId <= 0) throw new Error("Not an iNaturalist taxon id");

  const taxonRes = await httpFetch(`${INAT_TAXA_API}/${inatTaxonId}`, LOOKUP);
  if (!taxonRes.ok) throw new Error("Couldn't look up that species on iNaturalist");
  const taxonData = (await taxonRes.json()) as {
    results: Array<{
      id: number;
      name: string;
      preferred_common_name?: string;
      iconic_taxon_name?: string;
      // The singular `conservation_status` is place-aware and null without a place, so the
      // plural list is what's read.
      conservation_statuses?: Array<{
        status: string;
        authority: string;
        place: unknown | null;
        iucn: number | null;
      }> | null;
    }>;
  };
  const taxon = taxonData.results[0];
  if (!taxon) throw new Error("Species not found on iNaturalist");
  // Conservation status fills the rarity badge's slot. A global assessment (IUCN first) wins;
  // most of these taxa only have regional ones, and any real status beats none.
  const statuses = taxon.conservation_statuses ?? [];
  const globalStatuses = statuses.filter((s) => s.place == null);
  const best =
    globalStatuses.find((s) => s.authority === "IUCN Red List") ??
    globalStatuses[0] ??
    statuses.find((s) => s.authority === "IUCN Red List") ??
    statuses[0] ??
    null;
  // Every conservation_statuses entry, whatever the authority or place, carries iNat's normalized
  // numeric `iucn` level, so one mapping (packages/shared/src/iucn.ts) reads them all.
  const iucnStatus = best ? (iucnCodeFromInatLevel(best.iucn) ?? normalizeIucnStatus(best.status)) : null;

  // The real GBIF key when one resolves, else a synthetic negative one (real keys are positive).
  let gbifKey = -taxon.id;
  // Family and order come from the same GBIF match and fill the detail page's stats box.
  let family: string | null = null;
  let order: string | null = null;
  try {
    const gbifRes = await httpFetch(
      `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(taxon.name)}&strict=false`,
      LOOKUP,
    );
    const gbifData = (await gbifRes.json()) as { usageKey?: number; family?: string; order?: string };
    if (gbifData.usageKey) gbifKey = gbifData.usageKey;
    family = gbifData.family ?? null;
    order = gbifData.order ?? null;
  } catch {
    // Best effort: the synthetic key works, and family/order just stay empty.
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class, is_other_taxa, inat_taxon_id, inat_iconic_taxon, family, taxon_order)
     VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8)
     ON CONFLICT (gbif_key) DO UPDATE SET gbif_key = species.gbif_key
     RETURNING id`,
    [
      gbifKey,
      taxon.name,
      taxon.preferred_common_name ? titleCaseCommonName(taxon.preferred_common_name) : null,
      (taxon.iconic_taxon_name ?? "other").toLowerCase(),
      taxon.id,
      taxon.iconic_taxon_name ?? null,
      family,
      order,
    ],
  );
  const speciesId = inserted.rows[0].id;
  // Conservation status lives in species_traits like every species' (migration 129). DO NOTHING:
  // the gbif_key conflict above can hand back an existing species, whose status stays its own.
  if (iucnStatus) {
    await pool.query(
      `INSERT INTO species_traits (species_id, iucn_status, iucn_source, source_attribution)
       VALUES ($1, $2, 'inaturalist', 'iNaturalist') ON CONFLICT (species_id) DO NOTHING`,
      [speciesId, iucnStatus],
    );
  }

  // enrichLater: someone is waiting on the species itself, and its photos can follow. A failure
  // there is harmless, the species page fetches what's missing when it opens.
  const enriching = enrichOtherTaxaSpecies(speciesId, taxon.name);
  if (enrichLater) enriching.catch((err) => log.warn({ err, speciesId }, "Other Taxa enrichment failed"));
  else await enriching;
  return { speciesId, scientificName: taxon.name };
}

// The same photo and description enrichment as every other species; persistEnrichment also
// computes its reference vector, so it's matchable once this finishes.
async function enrichOtherTaxaSpecies(speciesId: string, scientificName: string): Promise<void> {
  const enrichment = await enrichSpecies({ id: speciesId, scientific_name: scientificName });
  await persistEnrichment(speciesId, enrichment);
  if (enrichment.gallery.length > 0) {
    await persistGalleryPromotingMainIfMissing(speciesId, enrichment.gallery, enrichment.referencePhoto != null);
  }
}
