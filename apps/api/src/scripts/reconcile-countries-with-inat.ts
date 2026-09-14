// Runs the iNat-membership reconcile (see computeRegionOccurrencesFromCache/
// computeRegionOccurrences) over every one of the world's 251 countries — including ones
// already fully computed via the old GBIF-only pipeline. iNat Research-Grade records decide
// checklist MEMBERSHIP for each of them (species iNat doesn't confirm get dropped, species iNat
// confirms that GBIF missed get added), while GBIF still supplies the occurrence/rarity-tier
// DATA for whichever species land on each checklist — a species that's already both present and
// already tiered is left completely untouched, so a country that was fine before this pass
// isn't redone from scratch, just reconciled.
//
// Prefers the local GBIF country-cache (packages/data-pipeline/data/gbif-country-cache/{iso2}.zip
// — see computeFromGbifCache.ts's own comment) over live GBIF API calls whenever that country's
// zip is already on disk: a local parse instead of a rate-limited live sweep, same accuracy
// trade-off compute-provinces-bulk.ts already accepts for provinces. Falls back to the live path
// for whichever handful of countries have no cached zip yet.
//
// Usage: npx tsx src/scripts/reconcile-countries-with-inat.ts [--limit=N] [--countries=A,B,...]
import "../config.js";
import { pool } from "../db.js";
import { computeRegionOccurrences } from "../regions/routes.js";
import { computeRegionOccurrencesFromCache, hasCachedGbifData } from "../regions/computeFromGbifCache.js";
import { fetchAllCountries } from "data-pipeline/src/fetch/fetch-region-boundary.js";

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  const countriesArg = process.argv.find((a) => a.startsWith("--countries="));
  const countryNames = countriesArg ? countriesArg.split("=")[1].split(",") : null;

  const res = await pool.query<{
    id: string;
    name: string;
    boundary_geojson: unknown;
    external_codes: string[] | null;
  }>(
    `SELECT r.id, r.name, r.boundary_geojson, r.external_codes
     FROM regions r
     JOIN regions cont ON cont.id = r.parent_id
     JOIN regions w ON w.id = cont.parent_id AND w.name = 'World'
     WHERE array_length(r.external_codes, 1) > 0
       ${countryNames ? "AND r.name = ANY($1)" : ""}
     ORDER BY r.name`,
    countryNames ? [countryNames] : [],
  );
  const countries = limit ? res.rows.slice(0, limit) : res.rows;
  console.log(`[reconcile-countries-with-inat] ${countries.length} countr(ies) to reconcile`);

  const allCountries = await fetchAllCountries();
  const iso3ToIso2 = new Map(allCountries.filter((c) => c.iso2 && /^[A-Z]{2}$/.test(c.iso2)).map((c) => [c.iso3, c.iso2!]));

  let done = 0;
  let failed = 0;
  let viaCache = 0;
  for (const country of countries) {
    try {
      const before = await pool.query<{ count: string }>(`SELECT count(*) FROM region_species WHERE region_id = $1`, [country.id]);
      const iso3 = country.external_codes?.[0];
      const iso2 = iso3 ? iso3ToIso2.get(iso3) : undefined;
      let usedCache = false;
      if (iso2 && hasCachedGbifData(iso2)) {
        usedCache = await computeRegionOccurrencesFromCache({ id: country.id, name: country.name }, iso2);
      }
      if (!usedCache) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await computeRegionOccurrences(country as any);
      } else {
        viaCache++;
      }
      const after = await pool.query<{ count: string }>(`SELECT count(*) FROM region_species WHERE region_id = $1`, [country.id]);
      done++;
      console.log(
        `[reconcile-countries-with-inat] ${done + failed}/${countries.length} ${country.name}${usedCache ? " (cache)" : " (live)"}: ${before.rows[0].count} -> ${after.rows[0].count} species`,
      );
    } catch (err) {
      failed++;
      console.error(`[reconcile-countries-with-inat] FAILED ${country.name}:`, err);
    }
  }
  console.log(`[reconcile-countries-with-inat] done. ${done} reconciled (${viaCache} via cache), ${failed} failed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
