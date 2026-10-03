// Other Taxa: species Lifer has no dataset for (insects, plants, fungi, ...), found and added
// from iNaturalist by name. Behind the any_taxa_search_enabled opt-in, since it's a live lookup.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../db.js";
import { isUuid } from "../lib/validate.js";
import { requireAuth } from "../auth/session.js";
import { enrichSpecies, persistEnrichment, persistGalleryPromotingMainIfMissing } from "./lazyEnrich.js";
import { createJob } from "../lib/job.js";

const INAT_TAXA_API = "https://api.inaturalist.org/v1/taxa";
const OTHER_TAXA_USER_AGENT = "lifer-app/0.1 (personal project; any-taxa search)";
// Every conservation_statuses entry, whatever the authority or place, carries iNat's normalized
// numeric `iucn` level, so one table labels them all.
const IUCN_LEVEL_NAMES: Record<number, string> = {
  0: "Not Evaluated",
  5: "Data Deficient",
  10: "Least Concern",
  20: "Near Threatened",
  30: "Vulnerable",
  40: "Endangered",
  50: "Critically Endangered",
  60: "Extinct in the Wild",
  70: "Extinct",
};

// iNaturalist's vernacular names are inconsistently cased; the rest of the catalog is title case.
function titleCaseCommonName(name: string): string {
  return name.replace(/(^|[\s-])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

async function requireAnyTaxaSearchEnabled(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const res = await pool.query<{ any_taxa_search_enabled: boolean }>(`SELECT any_taxa_search_enabled FROM users WHERE id = $1`, [
    request.user!.id,
  ]);
  if (!res.rows[0]?.any_taxa_search_enabled) {
    reply.code(403).send({ error: "Any-taxa search isn't enabled (Settings > Species & Import)" });
    return false;
  }
  return true;
}

/** The species row for an iNat taxon, created and enriched on first use. Doesn't touch
 *  region_species; each caller decides that. */
async function resolveOrCreateOtherTaxaSpecies(inatTaxonId: number): Promise<{ speciesId: string; scientificName: string }> {
  const existing = await pool.query<{ id: string; scientific_name: string }>(
    `SELECT id, scientific_name FROM species WHERE inat_taxon_id = $1 AND is_other_taxa = true`,
    [inatTaxonId],
  );
  if (existing.rows[0]) return { speciesId: existing.rows[0].id, scientificName: existing.rows[0].scientific_name };

  const taxonRes = await fetch(`${INAT_TAXA_API}/${inatTaxonId}`, {
    headers: { "User-Agent": OTHER_TAXA_USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!taxonRes.ok) throw new Error("Couldn't look up that species on iNaturalist");
  const taxonData = (await taxonRes.json()) as {
    results: Array<{
      id: number;
      name: string;
      preferred_common_name?: string;
      iconic_taxon_name?: string;
      // The singular `conservation_status` is place-aware and null without a place, so the
      // plural list is what's read.
      conservation_statuses?: Array<{ status: string; authority: string; place: unknown | null; iucn: number | null }> | null;
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
  const iucnStatus = best?.iucn != null ? (IUCN_LEVEL_NAMES[best.iucn] ?? best.status) : null;

  // The real GBIF key when one resolves, else a synthetic negative one (real keys are positive).
  let gbifKey = -taxon.id;
  // Family and order come from the same GBIF match and fill the detail page's stats box.
  let family: string | null = null;
  let order: string | null = null;
  try {
    const gbifRes = await fetch(`https://api.gbif.org/v1/species/match?name=${encodeURIComponent(taxon.name)}&strict=false`, {
      signal: AbortSignal.timeout(15_000),
    });
    const gbifData = (await gbifRes.json()) as { usageKey?: number; family?: string; order?: string };
    if (gbifData.usageKey) gbifKey = gbifData.usageKey;
    family = gbifData.family ?? null;
    order = gbifData.order ?? null;
  } catch {
    // Best effort: the synthetic key works, and family/order just stay empty.
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class, is_other_taxa, inat_taxon_id, inat_iconic_taxon, iucn_status, family, taxon_order)
     VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9)
     ON CONFLICT (gbif_key) DO UPDATE SET gbif_key = species.gbif_key
     RETURNING id`,
    [
      gbifKey,
      taxon.name,
      taxon.preferred_common_name ? titleCaseCommonName(taxon.preferred_common_name) : null,
      (taxon.iconic_taxon_name ?? "other").toLowerCase(),
      taxon.id,
      taxon.iconic_taxon_name ?? null,
      iucnStatus,
      family,
      order,
    ],
  );
  const speciesId = inserted.rows[0].id;

  // The same photo and description enrichment as every other species; persistEnrichment also
  // computes its reference vector, so it's matchable right away.
  const enrichment = await enrichSpecies({ id: speciesId, scientific_name: taxon.name });
  await persistEnrichment(speciesId, enrichment);
  if (enrichment.gallery.length > 0) {
    await persistGalleryPromotingMainIfMissing(speciesId, enrichment.gallery, enrichment.referencePhoto != null);
  }
  return { speciesId, scientificName: taxon.name };
}

// Live counters are top-level; `result` repeats them once the run finishes.
interface OtherTaxaBulkExtra {
  added: number;
  alreadyPresent: number;
  notFound: string[];
}

export async function otherTaxaRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string } }>("/species/inat-search", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireAnyTaxaSearchEnabled(request, reply))) return;
    const q = (request.query.q ?? "").trim();
    if (q.length < 2) return { results: [] };
    const res = await fetch(`${INAT_TAXA_API}?q=${encodeURIComponent(q)}&rank=species&is_active=true&per_page=15`, {
      headers: { "User-Agent": OTHER_TAXA_USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!res) return reply.code(502).send({ error: "iNaturalist search failed" });
    if (!res.ok) return reply.code(502).send({ error: "iNaturalist search failed" });
    const data = (await res.json()) as {
      results: Array<{
        id: number;
        name: string;
        preferred_common_name?: string;
        iconic_taxon_name?: string;
        default_photo?: { square_url?: string } | null;
      }>;
    };
    return {
      results: data.results.map((t) => ({
        inatTaxonId: t.id,
        scientificName: t.name,
        commonName: t.preferred_common_name ? titleCaseCommonName(t.preferred_common_name) : null,
        iconicTaxon: t.iconic_taxon_name ?? null,
        thumbnailUrl: t.default_photo?.square_url ?? null,
      })),
    };
  });

  app.post<{ Body: { inatTaxonId?: number; regionId?: string } }>(
    "/species/other-taxa",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!(await requireAnyTaxaSearchEnabled(request, reply))) return;
      const { inatTaxonId, regionId } = request.body ?? {};
      if (!inatTaxonId || !regionId) return reply.code(400).send({ error: "inatTaxonId and regionId are required" });

      if (!isUuid(regionId)) return reply.code(404).send({ error: "Region not found" });
      const regionRes = await pool.query(`SELECT id FROM regions WHERE id = $1`, [regionId]);
      if (regionRes.rows.length === 0) return reply.code(404).send({ error: "Region not found" });

      let speciesId: string;
      try {
        ({ speciesId } = await resolveOrCreateOtherTaxaSpecies(inatTaxonId));
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }

      // No rarity or occurrence data for these, so the frequency and tier columns stay NULL.
      await pool.query(
        `INSERT INTO region_species (region_id, species_id, is_vagrant, is_invasive)
         VALUES ($1, $2, false, false)
         ON CONFLICT (region_id, species_id) DO NOTHING`,
        [regionId, speciesId],
      );

      return { speciesId };
    },
  );

  // Removes an Other Taxa species. Refused while you have photos of it (they'd be orphaned).
  app.delete<{ Params: { id: string } }>("/species/:id/other-taxa", { preHandler: requireAuth }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Species not found" });
    const { id: speciesId } = request.params;
    const userId = request.user!.id;

    const speciesRes = await pool.query<{ is_other_taxa: boolean }>(`SELECT is_other_taxa FROM species WHERE id = $1`, [speciesId]);
    if (speciesRes.rows.length === 0) return reply.code(404).send({ error: "Species not found" });
    if (!speciesRes.rows[0].is_other_taxa) {
      return reply.code(400).send({ error: "Only an Other Taxa species can be removed this way" });
    }

    const captureCountRes = await pool.query<{ count: string }>(
      `SELECT count(*) FROM captures_all c
       WHERE c.user_id = $1 AND (c.species_id = $2 OR EXISTS (SELECT 1 FROM capture_species cs WHERE cs.capture_id = c.id AND cs.species_id = $2))`,
      [userId, speciesId],
    );
    if (Number(captureCountRes.rows[0].count) > 0) {
      return reply
        .code(409)
        .send({ error: "You have photos of this species. Delete or reassign them first, then remove it." });
    }

    await pool.query(`DELETE FROM user_species WHERE user_id = $1 AND species_id = $2`, [userId, speciesId]);
    await pool.query(`DELETE FROM user_archived_species WHERE user_id = $1 AND species_id = $2`, [userId, speciesId]);
    // region_species is shared, so this removes it for every user on the install.
    await pool.query(`DELETE FROM region_species WHERE species_id = $1`, [speciesId]);

    // The catalog row goes only when nothing else references it (the FKs don't cascade).
    try {
      await pool.query(`DELETE FROM species WHERE id = $1`, [speciesId]);
    } catch (err) {
      request.log.warn({ err, speciesId }, "Other Taxa species still referenced elsewhere: checklist entry removed, catalog row kept");
    }

    return { ok: true };
  });

  // Bulk import of a pasted list (scientific names, common names or iNat taxon ids, one per
  // line) into a region's Other Taxa, as a background job.
  const otherTaxaBulkJob = createJob<OtherTaxaBulkExtra, OtherTaxaBulkExtra>("other-taxa-bulk", {
    added: 0,
    alreadyPresent: 0,
    notFound: [],
  });

  app.get("/species/other-taxa/bulk/status", { preHandler: requireAuth }, async () => otherTaxaBulkJob.status);

  app.post("/species/other-taxa/bulk/cancel", { preHandler: requireAuth }, async () => ({ cancelled: otherTaxaBulkJob.cancel() }));

  app.post<{ Body: { regionId?: string; entries?: string[] } }>(
    "/species/other-taxa/bulk",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!(await requireAnyTaxaSearchEnabled(request, reply))) return;
      if (otherTaxaBulkJob.status.running) return reply.code(409).send({ error: "A bulk import is already running" });
      const { regionId, entries } = request.body ?? {};
      if (!regionId || !Array.isArray(entries) || entries.length === 0) {
        return reply.code(400).send({ error: "regionId and a non-empty entries list are required" });
      }
      if (!isUuid(regionId)) return reply.code(404).send({ error: "Region not found" });
      const regionRes = await pool.query(`SELECT id FROM regions WHERE id = $1`, [regionId]);
      if (regionRes.rows.length === 0) return reply.code(404).send({ error: "Region not found" });

      // Deduped and blanks dropped before the total is reported.
      const lines = [...new Set(entries.map((e) => e.trim()).filter((e) => e.length > 0))];
      if (lines.length === 0) return reply.code(400).send({ error: "No usable entries found" });

      // Background job; the frontend polls /species/other-taxa/bulk/status.
      const started = otherTaxaBulkJob.start(
        async (ctx) => {
          const job = otherTaxaBulkJob.status;
          let processed = 0;
          for (const line of lines) {
            ctx.throwIfCancelled();
            ctx.update({ currentItem: line });
            try {
              let taxonId: number | null = null;
              if (/^\d+$/.test(line)) {
                taxonId = Number(line);
              } else {
                const searchRes = await fetch(`${INAT_TAXA_API}?q=${encodeURIComponent(line)}&rank=species&is_active=true&per_page=1`, {
                  headers: { "User-Agent": OTHER_TAXA_USER_AGENT },
                  signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]),
                });
                if (searchRes.ok) {
                  const searchData = (await searchRes.json()) as { results: Array<{ id: number }> };
                  taxonId = searchData.results[0]?.id ?? null;
                }
              }
              if (taxonId == null) {
                job.notFound.push(line);
              } else {
                const { speciesId } = await resolveOrCreateOtherTaxaSpecies(taxonId);
                const insertRes = await pool.query(
                  `INSERT INTO region_species (region_id, species_id, is_vagrant, is_invasive)
                   VALUES ($1, $2, false, false)
                   ON CONFLICT (region_id, species_id) DO NOTHING`,
                  [regionId, speciesId],
                );
                if (insertRes.rowCount && insertRes.rowCount > 0) job.added++;
                else job.alreadyPresent++;
              }
            } catch {
              ctx.throwIfCancelled();
              job.notFound.push(line);
            }
            ctx.update({ processed: ++processed });
            // Paced: each line makes several iNaturalist calls, and an unpaced burst draws 429s.
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          return { added: job.added, alreadyPresent: job.alreadyPresent, notFound: [...job.notFound] };
        },
        { phase: "importing", processed: 0, total: lines.length },
      );
      if (!started) return reply.code(409).send({ error: "A bulk import is already running" });

      return { started: true, total: lines.length };
    },
  );
}
