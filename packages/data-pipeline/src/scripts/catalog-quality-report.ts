// A snapshot of catalog quality for a few regions, to compare before and after a rebuild:
//   - species by taxon group and local tier, how many have no tier, and how many are
//     "legendary with frequency 0";
//   - well-known species that must be on each region's checklist, with their tier and records;
//   - the global tier spread per group.
// The scripts that build checklists report success whether or not the data is right, so this is
// the check that the data is.
//
//   npx tsx src/scripts/catalog-quality-report.ts <out.json>
import { writeFileSync } from "node:fs";
import { pool } from "../db.js";

// Species people see easily in these places. A missing one, or one tiered rare/legendary with
// thousands of local records, is a data problem. Catalog names (the older GBIF ones where renamed).
const MUST_HAVE: Record<string, string[]> = {
  "Costa Rica": [
    "Iguana iguana", "Basiliscus plumifrons", "Basiliscus basiliscus", "Ctenosaura similis", "Ara macao",
    "Ramphastos sulfuratus", "Pteroglossus torquatus", "Accipiter bicolor", "Sphiggurus mexicanus", "Bradypus variegatus",
    "Choloepus hoffmanni", "Alouatta palliata", "Cebus imitator", "Nasua narica", "Agalychnis callidryas",
    "Oophaga pumilio", "Dendrobates auratus", "Crocodylus acutus", "Chelonia mydas", "Quiscalus mexicanus",
    "Pitangus sulphuratus", "Cathartes aura", "Coragyps atratus", "Amazilia tzacatl", "Melanerpes hoffmannii",
  ],
  Canada: [
    "Accipiter cooperii", "Accipiter gentilis", "Accipiter striatus", "Grus americana", "Gulo gulo", "Branta canadensis",
    "Turdus migratorius", "Alces alces", "Ursus americanus", "Haliaeetus leucocephalus", "Castor canadensis",
    "Lithobates sylvaticus", "Thamnophis sirtalis", "Chrysemys picta", "Cyanocitta cristata", "Poecile atricapillus",
  ],
  "British Columbia": [
    "Accipiter cooperii", "Accipiter gentilis", "Haliaeetus leucocephalus", "Ursus americanus", "Ursus arctos",
    "Odocoileus hemionus", "Megaceryle alcyon", "Dryocopus pileatus", "Lithobates catesbeianus", "Thamnophis sirtalis",
  ],
};

async function main() {
  const out = process.argv[2] ?? "catalog-quality-report.json";
  const report: Record<string, unknown> = { at: new Date().toISOString(), regions: {} };

  for (const [regionName, mustHave] of Object.entries(MUST_HAVE)) {
    const region = (
      await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1 AND array_length(external_codes, 1) > 0 ORDER BY id LIMIT 1`, [
        regionName,
      ])
    ).rows[0];
    if (!region) continue;
    const byGroup = await pool.query<{ taxon_class: string; tier: string | null; n: number; zero_legendary: number }>(
      `SELECT s.taxon_class, rs.local_tier AS tier, count(*)::int AS n,
              count(*) FILTER (WHERE rs.local_tier = 'legendary' AND COALESCE(rs.local_frequency, 0) = 0)::int AS zero_legendary
         FROM region_species rs JOIN species s ON s.id = rs.species_id
        WHERE rs.region_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
      [region.id],
    );
    const groups: Record<string, Record<string, number>> = {};
    let zeroLegendary = 0;
    for (const r of byGroup.rows) {
      groups[r.taxon_class] ??= {};
      groups[r.taxon_class][r.tier ?? "none"] = r.n;
      zeroLegendary += r.zero_legendary;
    }
    const species = await pool.query<{ scientific_name: string; common_name: string | null; tier: string | null; freq: string | null; global: string | null }>(
      `SELECT s.scientific_name, s.common_name, rs.local_tier AS tier, rs.local_frequency::text AS freq, r.tier AS global
         FROM species s
         LEFT JOIN region_species rs ON rs.species_id = s.id AND rs.region_id = $1
         LEFT JOIN species_rarity r ON r.species_id = s.id
        WHERE s.scientific_name = ANY($2)`,
      [region.id, mustHave],
    );
    const onList = await pool.query<{ species_id: string }>(`SELECT species_id FROM region_species WHERE region_id = $1`, [region.id]);
    const present = new Set(onList.rows.map((r) => r.species_id));
    const ids = await pool.query<{ id: string; scientific_name: string }>(`SELECT id, scientific_name FROM species WHERE scientific_name = ANY($1)`, [mustHave]);
    const idByName = new Map(ids.rows.map((r) => [r.scientific_name, r.id]));
    (report.regions as Record<string, unknown>)[regionName] = {
      total: onList.rows.length,
      zeroLegendary,
      groups,
      mustHave: mustHave.map((name) => {
        const row = species.rows.find((r) => r.scientific_name === name);
        const id = idByName.get(name);
        return {
          name,
          common: row?.common_name ?? null,
          inCatalog: !!id,
          onChecklist: !!id && present.has(id),
          tier: row?.tier ?? null,
          records: row?.freq != null ? Number(row.freq) : null,
          globalTier: row?.global ?? null,
        };
      }),
    };
  }

  const global = await pool.query<{ taxon_class: string; tier: string; n: number }>(
    `SELECT s.taxon_class, r.tier, count(*)::int AS n FROM species_rarity r JOIN species s ON s.id = r.species_id
      WHERE s.taxon_class IN ('aves', 'mammalia', 'actinopterygii', 'squamata', 'amphibia') GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  const globalTiers: Record<string, Record<string, number>> = {};
  for (const r of global.rows) (globalTiers[r.taxon_class] ??= {})[r.tier] = r.n;
  report.globalTiers = globalTiers;
  report.synonyms = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM species_synonyms`)).rows[0].n;
  report.birdsWithoutEbird = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM species WHERE taxon_class = 'aves' AND ebird_code IS NULL`)).rows[0].n;
  report.withoutInat = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM species WHERE inat_taxon_id IS NULL AND is_other_taxa = false`)).rows[0].n;

  writeFileSync(out, JSON.stringify(report, null, 1));
  for (const [name, r] of Object.entries(report.regions as Record<string, any>)) {
    const missing = r.mustHave.filter((m: any) => !m.onChecklist).map((m: any) => m.common ?? m.name);
    console.log(`${name}: ${r.total} species, ${r.zeroLegendary} "legendary with 0 records", missing: ${missing.join(", ") || "none"}`);
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
