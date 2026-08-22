// A species whose only presence on an entire continent is a near-single-record outlier, while
// it has real, non-outlier presence on a DIFFERENT continent, is very unlikely to be a genuine
// vagrant. Real vagrancy (even rare) usually shows some presence in geographically
// connected/intervening regions, not a total continental jump with nothing in between. For
// example, Golden Pheasant (native to central China) shows up as a near-single-record "epic"
// entry in BC via scattered captive/escaped individuals — not genuine vagrancy. This doesn't
// need any external native-range dataset: the region hierarchy already encodes continents
// structurally (World -> Continent -> Country -> Province), so a region's continent is just
// its ancestor one level below World.
//
// Uses the same safety combination already used for extinct_in_wild (see
// purge-implausible-extinct-regions.ts): the near-single-record-outlier signal (epic/
// legendary tier + local_frequency <= 2) alone isn't trusted for removal, but combined with
// "this species has zero real presence anywhere on this whole continent, despite having real
// presence on another one" it's a strong, structural signal. A genuine rare continental
// vagrant (e.g. a real Asian shorebird blown across the Pacific) would still need to be
// checked case-by-case if it starts tripping this — logged in full before deleting so that's
// reviewable, not silent.
import { pool } from "../db.js";

interface RegionRow {
  region_id: string;
  region_name: string;
  parent_id: string | null;
}

async function buildContinentByRegionId(): Promise<Map<string, string>> {
  const res = await pool.query<RegionRow>(`SELECT id AS region_id, name AS region_name, parent_id FROM regions`);
  const byId = new Map(res.rows.map((r) => [r.region_id, r]));
  const worldRow = res.rows.find((r) => r.region_name === "World");
  const worldId = worldRow?.region_id ?? null;

  const continentByRegionId = new Map<string, string>();
  for (const row of res.rows) {
    let current: RegionRow | undefined = row;
    let continent: RegionRow | null = null;
    // Walk up until the parent is World (or we run out) — that node is the continent.
    // Depth-capped: a one-row data bug (e.g. Antarctica's parent_id pointing to itself instead
    // of World) can turn this into an infinite loop that pegs a CPU core indefinitely. The
    // real hierarchy is only ever 4 levels deep (World -> continent -> country -> province),
    // so 20 is a generous, safe ceiling — hitting it means bad data, not a legitimately deep
    // region tree.
    for (let depth = 0; current && depth < 20; depth++) {
      if (current.parent_id === worldId) {
        continent = current;
        break;
      }
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    if (continent) continentByRegionId.set(row.region_id, continent.region_name);
  }
  return continentByRegionId;
}

async function main() {
  const continentByRegionId = await buildContinentByRegionId();

  const res = await pool.query<{
    species_id: string;
    scientific_name: string;
    common_name: string | null;
    taxon_class: string;
    region_id: string;
    region_name: string;
    local_tier: string;
    local_frequency: number;
  }>(
    `SELECT rs.species_id, s.scientific_name, s.common_name, s.taxon_class, rs.region_id, r.name AS region_name,
            rs.local_tier, rs.local_frequency
     FROM region_species rs
     JOIN species s ON s.id = rs.species_id
     JOIN regions r ON r.id = rs.region_id`,
  );

  const bySpecies = new Map<string, typeof res.rows>();
  for (const row of res.rows) {
    if (!bySpecies.has(row.species_id)) bySpecies.set(row.species_id, []);
    bySpecies.get(row.species_id)!.push(row);
  }

  const toRemove: Array<{ species_id: string; region_id: string; scientific_name: string; common_name: string | null; region_name: string; local_tier: string; local_frequency: number }> = [];
  const reviewOnly: typeof toRemove = [];

  // This needs a looser threshold than the extinct_in_wild combo's <=2: Golden Pheasant sits
  // at 7 BC records, which wouldn't clear a <=2 bar, yet genuinely-naturalized species
  // (European Starling, House Sparrow — real introduced populations, not escapee artifacts)
  // sit at hundreds of thousands of BC records. The gap is 4-5 orders of magnitude, so
  // there's no ambiguous middle ground a looser threshold risks catching by mistake.
  const OUTLIER_FREQUENCY_CEILING = 25;
  // "Not epic/legendary tier" alone doesn't mean a region's presence is trustworthy — a
  // species can rank merely "rare" with just 1 record if the region's whole checklist is
  // thin (e.g. Black-finned Squirrelfish). A "real" comparison point needs its own real
  // record floor, not just a tier escape.
  const MIN_REAL_RECORDS = 10;

  for (const rows of bySpecies.values()) {
    const isOutlier = (r: (typeof rows)[number]) => (r.local_tier === "epic" || r.local_tier === "legendary") && r.local_frequency <= OUTLIER_FREQUENCY_CEILING;
    const realRows = rows.filter((r) => !isOutlier(r) && r.local_frequency >= MIN_REAL_RECORDS);
    const outlierRows = rows.filter(isOutlier);
    if (realRows.length === 0 || outlierRows.length === 0) continue;

    const realContinents = new Set(realRows.map((r) => continentByRegionId.get(r.region_id)).filter((c): c is string => c != null));
    if (realContinents.size === 0) continue;

    for (const outlier of outlierRows) {
      const outlierContinent = continentByRegionId.get(outlier.region_id);
      // Birds are review-only, never auto-removed: real long-distance/transoceanic vagrancy is
      // documented ornithology for plenty of species (e.g. White-tailed Eagle, Alpine Swift),
      // and our region_species coverage is still incomplete worldwide (most regions haven't
      // even been computed yet), so "no real presence recorded on this continent in OUR data"
      // is much weaker evidence for birds specifically than it is for taxa with no comparable
      // vagrancy biology (a desert rodent or a Red Sea dolphin has no plausible way to cross
      // an ocean on its own).
      if (outlierContinent && !realContinents.has(outlierContinent)) {
        const target = outlier.taxon_class === "aves" ? reviewOnly : toRemove;
        target.push({
          species_id: outlier.species_id,
          region_id: outlier.region_id,
          scientific_name: outlier.scientific_name,
          common_name: outlier.common_name,
          region_name: outlier.region_name,
          local_tier: outlier.local_tier,
          local_frequency: outlier.local_frequency,
        });
      }
    }
  }

  console.log(`[purge-wrong-continent] ${toRemove.length} region_species rows: near-single-record outlier on a continent with zero real presence, while having real presence elsewhere`);
  for (const row of toRemove) {
    console.log(
      `  ${row.scientific_name} (${row.common_name ?? "no common name"}) from ${row.region_name} ` +
        `[${row.local_tier}, ${row.local_frequency} records]`,
    );
  }
  console.log(`[purge-wrong-continent] ${reviewOnly.length} bird candidates flagged for manual review only (never auto-removed):`);
  for (const row of reviewOnly) {
    console.log(
      `  [REVIEW] ${row.scientific_name} (${row.common_name ?? "no common name"}) from ${row.region_name} ` +
        `[${row.local_tier}, ${row.local_frequency} records]`,
    );
  }

  // Dry-run by default since this heuristic is newer and less battle-tested than the
  // extinct_in_wild combo: review the full list above before actually deleting. Set
  // LIFER_CONFIRM_DELETE=1 to actually remove them.
  if (toRemove.length === 0 || process.env.LIFER_CONFIRM_DELETE !== "1") {
    console.log(`[purge-wrong-continent] DRY RUN — set LIFER_CONFIRM_DELETE=1 to actually remove these.`);
    await pool.end();
    return;
  }

  let removed = 0;
  for (const row of toRemove) {
    const delRes = await pool.query(`DELETE FROM region_species WHERE species_id = $1 AND region_id = $2`, [row.species_id, row.region_id]);
    removed += delRes.rowCount ?? 0;
  }
  console.log(`[purge-wrong-continent] removed ${removed} region_species rows.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
