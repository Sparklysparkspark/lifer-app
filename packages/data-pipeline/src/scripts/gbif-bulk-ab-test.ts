// Compares a country checklist computed from a GBIF SQL download TSV (same core thresholds as
// build-region-species.ts) against that country's existing region_species rows: species set and
// vagrancy flags only, not every nuance of the full computation.
//
// Usage: npx tsx src/scripts/gbif-bulk-ab-test.ts --dir=<extracted GBIF download dir> [--country=Portugal] [--iso2=PT]
import { readFileSync, readdirSync } from "node:fs";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import { pool } from "@lifer/core/db.js";
import {
  MIN_RECORDS,
  FISH_MIN_RECORDS,
  RECENT_YEARS_WINDOW,
  RECURRENCE_ALLTIME_FLOOR,
  passesRecurrenceCheck,
} from "@lifer/core/regions/buildRegionSpecies.js";

const FISH_VAGRANT_MIN_RECORDS = 3;
// GBIF's SQL warehouse reports many ray-finned fish under finer classes (Teleostei, Chondrostei,
// Cladistii, Holostei) rather than Actinopterygii, so all of them are included.
const FISH_CLASSES = new Set([
  "Myxini",
  "Petromyzonti",
  "Elasmobranchii",
  "Holocephali",
  "Coelacanthi",
  "Dipneusti",
  "Actinopterygii",
  "Teleostei",
  "Chondrostei",
  "Cladistii",
  "Holostei",
]);
const BIRD_MAMMAL_CLASSES = new Set(["Aves", "Mammalia"]);

// One row per (species, countrycode, class, year) with a server-side aggregated record_count;
// unaggregated downloads are far too large.
interface OccRow {
  species: string;
  countrycode: string;
  year: number | null;
  class: string;
  recordCount: number;
}

async function loadTsv(tsvPath: string): Promise<OccRow[]> {
  const rows: OccRow[] = [];
  const rl = readline.createInterface({ input: createReadStream(tsvPath), crlfDelay: Infinity });
  let header: string[] | null = null;
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.split("\t");
    if (!header) {
      header = cols;
      continue;
    }
    const rec: Record<string, string> = {};
    header.forEach((h, i) => (rec[h] = cols[i] ?? ""));
    if (!rec.species || !rec.countrycode) continue;
    rows.push({
      species: rec.species,
      countrycode: rec.countrycode,
      year: rec.year ? Number(rec.year) : null,
      class: rec.class,
      recordCount: rec.record_count ? Number(rec.record_count) : 1,
    });
  }
  return rows;
}

function computeLocalChecklist(rows: OccRow[], countryIso2: string) {
  const currentYear = new Date().getFullYear();
  const forCountry = rows.filter((r) => r.countrycode === countryIso2);

  const byClass = (r: OccRow) => (FISH_CLASSES.has(r.class) || r.class === "" ? "fish-candidate" : r.class);
  // Unused: the download has only `class`, so fish are identified by FISH_CLASSES below.
  void byClass;

  const bySpecies = new Map<string, OccRow[]>();
  for (const r of forCountry) {
    if (!BIRD_MAMMAL_CLASSES.has(r.class) && !FISH_CLASSES.has(r.class)) continue;
    if (!bySpecies.has(r.species)) bySpecies.set(r.species, []);
    bySpecies.get(r.species)!.push(r);
  }

  const included = new Map<string, { recordCount: number; isVagrant: boolean; kind: "bird-mammal" | "fish" }>();

  for (const [species, occs] of bySpecies) {
    const isFish = FISH_CLASSES.has(occs[0].class);
    if (isFish) {
      const recordCount = occs.reduce((sum, o) => sum + o.recordCount, 0);
      if (recordCount < FISH_MIN_RECORDS) continue;
      included.set(species, { recordCount, isVagrant: recordCount < FISH_VAGRANT_MIN_RECORDS, kind: "fish" });
      continue;
    }
    // Bird/mammal: recent-window count first.
    const recentTotal = occs
      .filter((o) => o.year != null && o.year >= currentYear - RECENT_YEARS_WINDOW)
      .reduce((sum, o) => sum + o.recordCount, 0);
    const yearCounts = new Map<number, number>();
    for (const o of occs) if (o.year != null) yearCounts.set(o.year, (yearCounts.get(o.year) ?? 0) + o.recordCount);
    const yearCountArr = [...yearCounts.entries()].map(([year, count]) => ({ year, count }));
    const allTimeTotal = occs.reduce((sum, o) => sum + o.recordCount, 0);

    if (recentTotal >= MIN_RECORDS) {
      included.set(species, {
        recordCount: recentTotal,
        isVagrant: !passesRecurrenceCheck(yearCountArr),
        kind: "bird-mammal",
      });
      continue;
    }
    // Recurrence rescue.
    if (allTimeTotal >= RECURRENCE_ALLTIME_FLOOR && passesRecurrenceCheck(yearCountArr)) {
      included.set(species, { recordCount: allTimeTotal, isVagrant: false, kind: "bird-mammal" });
    }
  }

  return included;
}

async function main() {
  const dirArg = process.argv.find((a) => a.startsWith("--dir="))?.split("=")[1];
  const countryArg = process.argv.find((a) => a.startsWith("--country="))?.split("=")[1] ?? "Portugal";
  const isoArg = process.argv.find((a) => a.startsWith("--iso2="))?.split("=")[1] ?? "PT";
  if (!dirArg) throw new Error("usage: --dir=<extracted GBIF download dir> [--country=Portugal] [--iso2=PT]");

  const tsvName = readdirSync(dirArg).find((f) => f.endsWith(".csv") || f.endsWith(".tsv"));
  if (!tsvName) throw new Error(`no .csv/.tsv found in ${dirArg}: ${readFileSync(dirArg).toString()}`);
  console.log(`[ab-test] loading ${tsvName}...`);
  const rows = await loadTsv(`${dirArg}/${tsvName}`);
  console.log(`[ab-test] loaded ${rows.length} occurrence rows total`);

  const local = computeLocalChecklist(rows, isoArg);
  console.log(`[ab-test] local computation: ${local.size} species for ${countryArg} (${isoArg})`);

  const liveRes = await pool.query<{ scientific_name: string; is_vagrant: boolean; local_frequency: number }>(
    `SELECT s.scientific_name, rs.is_vagrant, rs.local_frequency
     FROM region_species rs JOIN species s ON s.id = rs.species_id JOIN regions r ON r.id = rs.region_id
     WHERE r.name = $1`,
    [countryArg],
  );
  const live = new Map(
    liveRes.rows.map((r) => [r.scientific_name, { isVagrant: r.is_vagrant, recordCount: r.local_frequency }]),
  );
  console.log(`[ab-test] live (existing) computation: ${live.size} species for ${countryArg}`);

  const onlyLocal = [...local.keys()].filter((s) => !live.has(s));
  const onlyLive = [...live.keys()].filter((s) => !local.has(s));
  const both = [...local.keys()].filter((s) => live.has(s));
  const vagrancyMismatches = both.filter((s) => local.get(s)!.isVagrant !== live.get(s)!.isVagrant);

  console.log(`\n[ab-test] === RESULTS for ${countryArg} ===`);
  console.log(`  species in both: ${both.length}`);
  console.log(`  only in local (bulk-download) computation: ${onlyLocal.length}`);
  console.log(`  only in live (existing GBIF-call) computation: ${onlyLive.length}`);
  console.log(`  vagrancy-flag mismatches among shared species: ${vagrancyMismatches.length}`);
  console.log(`  overlap ratio: ${((both.length / Math.max(local.size, live.size)) * 100).toFixed(1)}%`);

  if (onlyLocal.length > 0) console.log(`\n  sample only-in-local (up to 20): ${onlyLocal.slice(0, 20).join(", ")}`);
  if (onlyLive.length > 0) console.log(`\n  sample only-in-live (up to 20): ${onlyLive.slice(0, 20).join(", ")}`);
  if (vagrancyMismatches.length > 0)
    console.log(`\n  sample vagrancy mismatches (up to 20): ${vagrancyMismatches.slice(0, 20).join(", ")}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
