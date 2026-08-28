// Light data-density probe, run BEFORE the expensive full per-province recompute
// (recompute-all-regions.ts): for every drilled country, checks whether its provinces
// actually carry meaningfully different GBIF data, or whether the split just produces empty/
// near-empty lists everywhere (Thailand: all 3 provinces checked so far came back with ZERO
// real species after full computation, at the cost of dozens of GBIF calls each). Reuses the
// exact same facet-count call the real pipeline makes (fetchSpeciesCountsForRegion) but skips
// the expensive parts entirely — no monthly seasonality (24 calls/region), no per-species
// outlier/type-specimen scrutiny (the actual cost driver for species-rich regions) — so this
// is ~2 GBIF calls per province instead of ~30-100+.
//
// Decided per-country, not per-province (a person either sees "drill into provinces" as a
// meaningful option for a country or doesn't) from real observation density, never from land
// area or population — a small country can have excellent province-level data (Costa Rica:
// real birder density) while a huge one could still be sparse at that resolution; the only
// way to know is to ask GBIF directly.
import { pool } from "../db.js";
import { fetchSpeciesCountsForRegion, FISH_YEARS_WINDOW } from "data-pipeline/src/build/build-region-species.js";
import { fetchFishTaxonKeys } from "data-pipeline/src/fetch/fetch-fish-orders.js";
import { AVES_CLASS_KEY, MAMMALIA_CLASS_KEY } from "data-pipeline/src/fetch/fetch-gbif-backbone.js";

const BIRD_MAMMAL_TAXON_KEYS = [AVES_CLASS_KEY, MAMMALIA_CLASS_KEY];
// A province clearing this many distinct species (birds+mammals+fish combined) counts as
// carrying real data. Deliberately low — this isn't trying to judge "is this a rich
// checklist," just "is there any real signal here at all," since the expensive full pass is
// what actually builds the real checklist once a country passes this bar.
const MIN_SPECIES_FOR_MEANINGFUL_PROVINCE = 3;
// A country's split is worth keeping if at least this fraction of its provinces individually
// clear the bar above. Below this, the split reads as "empty almost everywhere, with maybe a
// stray exception" rather than genuine geographic variation worth showing.
const MEANINGFUL_PROVINCE_FRACTION = 0.5;

interface RegionRow {
  id: string;
  name: string;
  external_codes: string[];
}

// Exported for reuse by recompute-all-regions.ts, which runs this BEFORE its own expensive
// full pass so that pass can skip provinces already known not to be worth computing.
export async function probeProvinceValue(): Promise<void> {
  const fishKeys = await fetchFishTaxonKeys();

  const countries = await pool.query<RegionRow>(
    `SELECT id, name, external_codes FROM regions
     WHERE has_children = true AND array_length(external_codes, 1) > 0
     ORDER BY name`,
  );
  console.log(`[probe-province-value] ${countries.rows.length} drilled countries to evaluate`);

  let countriesMeaningful = 0;
  let countriesNotMeaningful = 0;
  let countriesSkipped = 0;

  for (const country of countries.rows) {
    const provinces = await pool.query<RegionRow>(
      `SELECT id, name, external_codes FROM regions
       WHERE parent_id = $1 AND array_length(external_codes, 1) > 0 AND province_split_meaningful IS NULL`,
      [country.id],
    );
    if (provinces.rows.length === 0) {
      countriesSkipped++;
      continue;
    }

    let meaningfulCount = 0;
    for (const province of provinces.rows) {
      const code = province.external_codes[0];
      try {
        const [birdMammal, fish] = await Promise.all([
          fetchSpeciesCountsForRegion(code, BIRD_MAMMAL_TAXON_KEYS),
          fetchSpeciesCountsForRegion(code, fishKeys, FISH_YEARS_WINDOW, false),
        ]);
        const distinctSpecies = birdMammal.length + fish.length;
        if (distinctSpecies >= MIN_SPECIES_FOR_MEANINGFUL_PROVINCE) meaningfulCount++;
      } catch (err) {
        console.error(`[probe-province-value]   FAILED probing ${province.name} (${country.name}):`, err);
      }
    }

    const fraction = meaningfulCount / provinces.rows.length;
    const meaningful = fraction >= MEANINGFUL_PROVINCE_FRACTION;
    await pool.query(`UPDATE regions SET province_split_meaningful = $1 WHERE parent_id = $2`, [meaningful, country.id]);

    if (meaningful) countriesMeaningful++;
    else countriesNotMeaningful++;
    console.log(
      `[probe-province-value] ${country.name}: ${meaningfulCount}/${provinces.rows.length} provinces meaningful ` +
        `(${(fraction * 100).toFixed(0)}%) -> ${meaningful ? "KEEP split" : "COLLAPSE to country level"}`,
    );
  }

  console.log(
    `[probe-province-value] done. ${countriesMeaningful} countries keep their split, ` +
      `${countriesNotMeaningful} collapse to country-level, ${countriesSkipped} had nothing to evaluate.`,
  );
}

// Only run standalone (and only then end the shared pool) when invoked directly, so
// recompute-all-regions.ts can import probeProvinceValue() without it closing the pool out
// from under the rest of that script.
if (import.meta.url === `file://${process.argv[1]}`) {
  probeProvinceValue()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
