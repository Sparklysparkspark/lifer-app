// Which country each endemic species lives in (species_traits.endemic_country_iso3), from the
// GBIF country downloads (src/rarity/endemicCountries.ts), leaving out countries GBIF's checklists
// say a species was introduced to (src/gbif/distributions.ts), then the hand-checked answers in
// data/reference/species-corrections.json. Run by the refresh's endemic stage.
// Only countries whose download changed are reread, and only species whose answer changed are
// written, so a rerun is quick and an interrupted one carries on.
//
//   npx tsx src/scripts/compute-endemic-countries.ts                         report what would change
//   npx tsx src/scripts/compute-endemic-countries.ts --apply                 write it
//   --full                  reread every country
//   --live-max-age-days=N   for a country with no download, reuse its live GBIF counts this long (180)
import { parseArgs } from "node:util";
import { fetchAllCountries } from "@lifer/core/regions/regionBoundary.js";
import { pool } from "../db.js";
import { countryEstablishment } from "../gbif/distributions.js";
import { loadSpeciesCorrections } from "../pipeline/speciesCorrections.js";
import {
  addCountryCounts,
  countryDownloads,
  emptyCountryCountTotals,
  countryGroupCounts,
  endemicCountGroups,
  endemicCountries,
  introducedCountries,
  islandQueryBox,
  simplifiedRingsFor,
} from "../rarity/endemicCountries.js";

const log = (m: string) => console.log(`[endemic-countries] ${m}`);
// A species introduced to many countries can still be native to one (Mandarin Duck, Red-eared Slider).
const MAX_COUNTRIES_FOR_INTRODUCED_LOOKUP = 30;

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      full: { type: "boolean", default: false },
      "live-max-age-days": { type: "string", default: "180" },
    },
  });
  const liveMaxAgeDays = Number(values["live-max-age-days"]);
  if (!Number.isFinite(liveMaxAgeDays)) throw new Error("--live-max-age-days needs a number");

  const groups = await endemicCountGroups();
  const countries = await fetchAllCountries();
  const zipByIso3 = countryDownloads(countries);
  // Synonyms too, so a renamed species' records (the downloads use current names) still count.
  // Real names (listed first) win over a synonym spelled the same.
  const names = await pool.query<{ name: string; gbif_key: string }>(
    `SELECT scientific_name AS name, gbif_key FROM species WHERE gbif_key IS NOT NULL
     UNION ALL
     SELECT ss.synonym_name, s.gbif_key FROM species_synonyms ss JOIN species s ON s.id = ss.species_id WHERE s.gbif_key IS NOT NULL`,
  );
  const gbifKeyByName = new Map<string, number>();
  for (const r of names.rows) if (!gbifKeyByName.has(r.name)) gbifKeyByName.set(r.name, Number(r.gbif_key));

  // Each country is folded in as it's read, so only one country's rows are in memory at a time.
  const totals = emptyCountryCountTotals();
  let reread = 0;
  for (const [i, country] of countries.entries()) {
    const zipName = zipByIso3.get(country.iso3) ?? null;
    const sharesDownload = country.iso2 != null && zipName == null;
    const islandBox = sharesDownload
      ? islandQueryBox(
          simplifiedRingsFor(country.feature),
          countries.filter((o) => o.iso3 !== country.iso3).map((o) => simplifiedRingsFor(o.feature)),
        )
      : null;
    const { counts, fresh } = await countryGroupCounts(
      { iso3: country.iso3, zipName, sharesDownload, islandBox },
      groups,
      {
        landRings: simplifiedRingsFor(country.feature),
        liveMaxAgeDays,
        full: values.full,
      },
    );
    addCountryCounts(totals, country.iso3, counts, groups, gbifKeyByName);
    if (fresh) reread++;
    if ((i + 1) % 20 === 0 || i + 1 === countries.length)
      log(`${i + 1}/${countries.length} countries (${reread} reread)`);
  }
  const { countryCountsByGbifKey, bboxKmByGbifKeyAndIso3 } = totals;
  // Only a species recorded in a few countries could be endemic once its introduced ones drop out.
  const lookup = [...countryCountsByGbifKey]
    .filter(([, byCountry]) => byCountry.size >= 2 && byCountry.size <= MAX_COUNTRIES_FOR_INTRODUCED_LOOKUP)
    .map(([key]) => key);
  const introduced = introducedCountries(await countryEstablishment(lookup, log), countries);
  const endemic = endemicCountries(countryCountsByGbifKey, bboxKmByGbifKeyAndIso3, countries, introduced);
  // Hand-checked answers (species-corrections.json) win over the records.
  const overrides = new Map(
    loadSpeciesCorrections()
      .filter((c) => c.endemicCountry !== undefined)
      .map((c) => [c.scientificName, c.endemicCountry ?? null]),
  );
  const knownIso3 = new Set(countries.map((c) => c.iso3));
  for (const [name, iso3] of overrides)
    if (iso3 != null && !knownIso3.has(iso3))
      throw new Error(`species corrections: ${name} has unknown endemicCountry ${iso3}`);

  // Extinct species keep what they had; Other Taxa species never get one.
  const species = await pool.query<{ id: string; name: string; gbif_key: string | null; current: string | null }>(
    `SELECT s.id, s.scientific_name AS name, s.gbif_key, t.endemic_country_iso3 AS current
     FROM species s JOIN species_traits t ON t.species_id = s.id
     WHERE t.fully_extinct = false AND NOT s.is_other_taxa`,
  );
  const changes = species.rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      current: r.current,
      next: overrides.has(r.name)
        ? overrides.get(r.name)!
        : r.gbif_key
          ? (endemic.get(Number(r.gbif_key)) ?? null)
          : null,
    }))
    .filter((r) => r.next !== r.current);
  const gained = changes.filter((c) => c.current == null).length;
  const lost = changes.filter((c) => c.next == null).length;
  log(
    `${endemic.size} species endemic to one country; ${changes.length} change` +
      ` (${gained} newly endemic, ${lost} no longer, ${changes.length - gained - lost} moved country)`,
  );
  // Losses and moves first: they're the changes worth a look before --apply.
  const listed = [
    ...changes.filter((c) => c.next == null || c.current != null),
    ...changes.filter((c) => c.current == null),
  ];
  for (const c of listed.slice(0, 40)) log(`  ${c.name}: ${c.current ?? "-"} -> ${c.next ?? "-"}`);
  if (listed.length > 40) log(`  ...and ${listed.length - 40} more`);
  if (!values.apply) {
    log("dry run, nothing written (--apply writes)");
    return;
  }
  await pool.query(
    `UPDATE species_traits t SET endemic_country_iso3 = c.iso3
     FROM unnest($1::uuid[], $2::text[]) AS c(id, iso3) WHERE t.species_id = c.id`,
    [changes.map((c) => c.id), changes.map((c) => c.next)],
  );
  log(`wrote ${changes.length} species`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
