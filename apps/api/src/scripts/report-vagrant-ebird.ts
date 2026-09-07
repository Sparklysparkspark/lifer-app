// Read-only triage pass over the bird entries left in vagrant-still-needs-search.jsonl (the
// residual after the GBIF-distributions and FishBase passes). Unlike FishBase's country.parquet,
// eBird's per-country species list (`/v2/product/spplist/{iso2}`) is NOT a curated native/
// introduced database — it's built from the same kind of citizen-submitted occurrence checklists
// that produced the original false-vagrant-flag problem, so a species *appearing* on it doesn't
// prove it isn't a vagrant (genuine rarities get logged too). The only signal it gives that's
// actually new is the opposite direction: if a species has been reported ZERO times, ever, in a
// whole country's eBird history, that's real evidence the underlying occurrence record behind
// our flag was bad data (misidentification, bad coordinates, wrong basisOfRecord) rather than a
// genuine vagrant sighting — worth a human look, not worth silently clearing or confirming either
// way. This script only reports that zero-record case; it makes no DB writes.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import "../config.js"; // loads .env from the repo root before anything below reads process.env
import { pool } from "../db.js";
import { fetchAllCountries } from "data-pipeline/src/fetch/fetch-region-boundary.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const STILL_NEEDS_SEARCH_LOG = "/Users/judahstarkey/.claude/jobs/d9ace272/tmp/vagrant-still-needs-search.jsonl";
const PROBABLE_BAD_DATA_REPORT = "/Users/judahstarkey/.claude/jobs/d9ace272/tmp/vagrant-probable-bad-data-ebird.jsonl";

const EBIRD_API_KEY = process.env.EBIRD_API_KEY;
const EBIRD_CONCURRENCY = 3;

interface NeedsSearchEntry {
  regionId: string;
  speciesId: string;
  scientificName: string;
  country: string;
  continent: string;
}

async function fetchCountrySpeciesCodes(iso2: string): Promise<Set<string> | null> {
  const res = await fetch(`https://api.ebird.org/v2/product/spplist/${iso2}`, {
    headers: { "X-eBirdApiToken": EBIRD_API_KEY! },
  });
  if (!res.ok) return null; // e.g. iso2 eBird doesn't recognize — leave those entries unjudged
  const codes = (await res.json()) as string[];
  return new Set(codes);
}

async function main() {
  if (!EBIRD_API_KEY) throw new Error("EBIRD_API_KEY not set in .env");
  if (!existsSync(STILL_NEEDS_SEARCH_LOG)) {
    throw new Error(`${STILL_NEEDS_SEARCH_LOG} not found — run the FishBase pass first`);
  }
  writeFileSync(PROBABLE_BAD_DATA_REPORT, "");

  const entries: NeedsSearchEntry[] = readFileSync(STILL_NEEDS_SEARCH_LOG, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const speciesIds = [...new Set(entries.map((e) => e.speciesId))];
  const speciesRes = await pool.query<{ id: string; taxon_class: string; ebird_code: string | null }>(
    `SELECT id, taxon_class, ebird_code FROM species WHERE id = ANY($1)`,
    [speciesIds],
  );
  const speciesById = new Map(speciesRes.rows.map((r) => [r.id, r]));

  const birdEntries = entries.filter((e) => {
    const s = speciesById.get(e.speciesId);
    return s?.taxon_class === "aves" && s.ebird_code;
  });
  console.log(`[report-vagrant-ebird] ${birdEntries.length} bird entries with an eBird code to check`);

  const countries = await fetchAllCountries();
  const iso2ByName = new Map(countries.filter((c) => c.iso2).map((c) => [c.name, c.iso2 as string]));

  const byCountry = new Map<string, NeedsSearchEntry[]>();
  for (const e of birdEntries) {
    if (!byCountry.has(e.country)) byCountry.set(e.country, []);
    byCountry.get(e.country)!.push(e);
  }
  console.log(`[report-vagrant-ebird] ${byCountry.size} distinct countries to query`);

  let zeroRecord = 0;
  let hasRecord = 0;
  let skippedNoIso2 = 0;
  let done = 0;

  await mapWithConcurrency([...byCountry.entries()], EBIRD_CONCURRENCY, async ([countryName, countryEntries]) => {
    const iso2 = iso2ByName.get(countryName);
    if (!iso2) {
      skippedNoIso2 += countryEntries.length;
      done++;
      return;
    }
    const codes = await fetchCountrySpeciesCodes(iso2);
    if (!codes) {
      skippedNoIso2 += countryEntries.length; // eBird didn't recognize this region code either
      done++;
      return;
    }
    for (const e of countryEntries) {
      const ebirdCode = speciesById.get(e.speciesId)!.ebird_code!;
      if (codes.has(ebirdCode)) {
        hasRecord++;
      } else {
        zeroRecord++;
        appendFileSync(PROBABLE_BAD_DATA_REPORT, JSON.stringify({ ...e, ebirdCode }) + "\n");
      }
    }
    done++;
    if (done % 20 === 0 || done === byCountry.size) {
      console.log(`[report-vagrant-ebird] ${done}/${byCountry.size} countries checked`);
    }
  });

  console.log(
    `[report-vagrant-ebird] done. ${zeroRecord} entries have ZERO eBird records ever (probable bad data, ` +
      `written to ${PROBABLE_BAD_DATA_REPORT}), ${hasRecord} have at least one eBird record (left as-is, ` +
      `inconclusive), ${skippedNoIso2} skipped (no ISO2 match or eBird didn't recognize the region code).`,
  );
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
