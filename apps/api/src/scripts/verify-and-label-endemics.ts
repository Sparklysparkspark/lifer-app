// Two jobs in one pass over every species currently flagged endemic_country_iso3 (set by
// compute-elusiveness.ts's 258-country crawl — see 018_endemic.sql):
//
// 1. VERIFY: that crawl only proves "this species cleared its per-country presence threshold
//    in exactly one of the countries WE crawled" — it says nothing about countries outside the
//    crawl's own taxon-group minRecords gate finding a stray record elsewhere. Confirmed live
//    on Synodontis schall (flagged Egypt-endemic upstream): a direct, ungated GBIF country
//    facet on its own gbifKey shows real, repeated (100+ record) presence in Sudan, Nigeria,
//    Gambia, Benin, Kenya, Mali... a normal wide-ranging Nile/West-African catfish, not a real
//    endemic. This re-derives the true country set directly per species (one facet call each,
//    cached — see fetch-with-retry.ts) and clears endemic_country_iso3 whenever more than one
//    country shows real (not one-off) presence.
// 2. LABEL: try to extract a richer, named-place label from the species' own Wikipedia summary
//    text (e.g. "the Nile," "Lake Malawi," "the Rocky Mountains" instead of just a country name)
//    — reusing an already-cached description where we have one, and falling back to
//    iNaturalist's wikipedia_summary (iNaturalist-only, no rate limiting — see lazyEnrich.ts's
//    top comment) when we don't. This runs independent of step 1's single-country result: a
//    real range/basin endemic (the Rockies span the US and Canada; many river systems cross
//    borders) is still a genuine, interesting endemism claim even though it fails the strict
//    single-country check — so a label found here is kept even when endemic_country_iso3 ends
//    up NULL. The plain-country-name fallback (species/routes.ts) is the one thing gated on
//    true single-country status, per the original request: never show a bare country name
//    unless the species really is only found in that one country. A species with no
//    extractable phrase, or one whose only extractable phrase is too broad to be informative
//    (e.g. "Asia," "the Northern Hemisphere" — see BROAD_LABEL_TERMS) just keeps
//    endemic_region_label NULL.
//
// Idempotent: only processes species with endemic_checked_at IS NULL, so a killed/resumed run
// picks up where it left off without re-spending GBIF/iNaturalist calls already paid for.
import { pool } from "../db.js";
import { fetchWithRetry } from "data-pipeline/src/fetch-with-retry.js";
import { fetchAllCountries } from "data-pipeline/src/fetch/fetch-region-boundary.js";
import { fetchINaturalistTaxon, fetchINaturalistWikipediaSummary } from "../species/lazyEnrich.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 2;

// A single stray record (an old museum specimen misfiled a country over, a captive escapee)
// shouldn't count as "real presence elsewhere" — but this is deliberately a much lower bar
// than the crawl's own MIN_COUNTRY_RECORDS=5000 country-total gate, since that gate is about
// country-wide data volume being trustworthy, not about whether THIS species has a real
// population there. A handful of independent records over multiple observers is enough to
// disprove single-country endemism even if the field data for that species is otherwise thin.
const REAL_PRESENCE_MIN_RECORDS = 3;

// Phrases a Wikipedia species summary uses to state endemism/restricted range, in the order
// they're checked (longest/most specific phrasing first, so a summary that happens to contain
// more than one of these gets the most informative match). Deliberately does NOT stop at every
// comma — a real endemism clause is often a comma-separated list of places ("the Mekong river
// in Laos, northern Vietnam and southern China" is one answer, not three), so only a period/
// semicolon or one of the later break-phrases (marking a shift to habitat/size/other details)
// ends the capture. Confirmed against a real case where stopping at the first comma silently
// dropped 2 of a 3-country river-basin range down to just the first country.
const STOP =
  "(?=[.;]| where| but| although| and is\\b| and has\\b| and can\\b| in waters| at elevations| at depths| reaching| growing to| with a maximum| and its maximum| it can\\b| spanning| spans\\b| ranging| extending| stretching| covering)";
const ENDEMISM_PHRASES = [
  new RegExp(`\\bendemic to (?:the )?([^.;]+?)${STOP}`, "i"),
  new RegExp(`\\brestricted to (?:the )?([^.;]+?)${STOP}`, "i"),
  new RegExp(`\\bconfined to (?:the )?([^.;]+?)${STOP}`, "i"),
  new RegExp(`\\b(?:found|occurs?) only in (?:the )?([^.;]+?)${STOP}`, "i"),
  new RegExp(`\\bonly (?:found|known) from (?:the )?([^.;]+?)${STOP}`, "i"),
];

const MAX_LABEL_LENGTH = 90;

// A label this broad is technically true ("endemic to Asia" narrows down a real, if huge,
// area) but isn't more informative than the plain country/multi-country fallback would already
// be, and doesn't hit the "huh, that's interesting" bar the feature is for. Checked as an exact
// match against the normalized extracted phrase (not a substring), so a genuinely specific
// label that happens to mention a continent in passing — "the Ethiopian highlands of Africa" —
// still passes through.
const BROAD_LABEL_TERMS = new Set([
  "africa",
  "asia",
  "europe",
  "north america",
  "south america",
  "central america",
  "antarctica",
  "oceania",
  "the americas",
  "the old world",
  "the new world",
  "the northern hemisphere",
  "the southern hemisphere",
  "the tropics",
  "the world",
]);

export function extractRegionLabel(text: string, countryName: string | null): string | null {
  for (const re of ENDEMISM_PHRASES) {
    const match = text.match(re);
    if (!match) continue;
    // A comma is allowed mid-capture (a real place-list, e.g. "Laos, northern Vietnam and
    // southern China") but a trailing one is just where the source sentence would have
    // continued past our stop point — trimmed so it can't dodge the exact-match broad-term
    // check below ("Asia," != "asia").
    const raw = match[1].trim().replace(/,+$/, "").trim();
    if (!raw || raw.length > MAX_LABEL_LENGTH) continue;
    if (BROAD_LABEL_TERMS.has(raw.toLowerCase())) continue;
    // Discard a match that's just the (verified single) country's own name again (e.g.
    // "endemic to Egypt") — that carries no more information than the plain country fallback
    // already shows. Only applies when we have one verified country to compare against; a
    // real multi-country range/basin label has nothing to be redundant with.
    if (countryName && raw.toLowerCase() === countryName.toLowerCase()) continue;
    return raw;
  }
  return null;
}

export async function fetchTrueCountrySet(gbifKey: number): Promise<Map<string, number>> {
  const url = `https://api.gbif.org/v1/occurrence/search?taxonKey=${gbifKey}&facet=country&facetLimit=250&limit=0`;
  const res = await fetchWithRetry(url, { method: "GET" });
  if (!res.ok) return new Map();
  const data = (await res.json()) as { facets?: Array<{ field: string; counts: Array<{ name: string; count: number }> }> };
  const countryFacet = data.facets?.find((f) => f.field === "COUNTRY");
  const byIso2 = new Map<string, number>();
  for (const c of countryFacet?.counts ?? []) byIso2.set(c.name, c.count);
  return byIso2;
}

async function main() {
  const countries = await fetchAllCountries();
  const iso2ToIso3 = new Map(countries.filter((c) => c.iso2).map((c) => [c.iso2 as string, c.iso3]));
  const iso3ToName = new Map(countries.map((c) => [c.iso3, c.name]));

  const res = await pool.query<{
    species_id: string;
    gbif_key: number;
    scientific_name: string;
    endemic_country_iso3: string;
    description: string | null;
    inat_taxon_id: number | null;
  }>(`
    SELECT s.id AS species_id, s.gbif_key, s.scientific_name, t.endemic_country_iso3, s.description, s.inat_taxon_id
    FROM species s
    JOIN species_traits t ON t.species_id = s.id
    WHERE t.endemic_country_iso3 IS NOT NULL AND t.endemic_checked_at IS NULL
    ORDER BY s.scientific_name
  `);
  console.log(`[verify-endemics] ${res.rows.length} candidate(s) to verify`);

  let done = 0;
  let corrected = 0;
  let labeled = 0;
  await mapWithConcurrency(res.rows, CONCURRENCY, async (row) => {
    try {
      const byIso2 = await fetchTrueCountrySet(row.gbif_key);
      const realCountries = [...byIso2.entries()].filter(([, count]) => count >= REAL_PRESENCE_MIN_RECORDS);

      // Only a genuinely single-country species gets a bare country-name fallback (per the
      // original ask: never say "endemic to Egypt" if it's really also in Sudan). Anything
      // else — 0 real countries (stale/mismatched gbifKey) or 2+ (a real multi-country
      // range/basin species) — clears this, but still gets a shot at a richer label below.
      let trueIso3: string | null = null;
      let countryName: string | null = null;
      if (realCountries.length === 1) {
        const [iso2] = realCountries[0];
        trueIso3 = iso2ToIso3.get(iso2) ?? row.endemic_country_iso3;
        countryName = iso3ToName.get(trueIso3) ?? trueIso3;
      } else if (realCountries.length > 1) {
        corrected++;
      }

      let summaryText = row.description;
      if (!summaryText) {
        const taxonId = row.inat_taxon_id ?? (await fetchINaturalistTaxon(row.scientific_name))?.id ?? null;
        if (taxonId) {
          const inatSummary = await fetchINaturalistWikipediaSummary(taxonId);
          summaryText = inatSummary?.summary ?? null;
        }
      }

      const label = summaryText ? extractRegionLabel(summaryText, countryName) : null;
      if (label) labeled++;

      await pool.query(
        `UPDATE species_traits SET endemic_country_iso3 = $1, endemic_region_label = $2, endemic_checked_at = now() WHERE species_id = $3`,
        [trueIso3, label, row.species_id],
      );
    } catch (err) {
      console.error(`[verify-endemics] FAILED ${row.scientific_name}:`, err);
    }
    done++;
    if (done % 50 === 0 || done === res.rows.length) {
      console.log(`[verify-endemics] ${done}/${res.rows.length} (${corrected} corrected, ${labeled} labeled)`);
    }
  });

  console.log(`[verify-endemics] done. ${done} processed, ${corrected} corrected (were not real single-country endemics), ${labeled} got a richer label.`);
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
