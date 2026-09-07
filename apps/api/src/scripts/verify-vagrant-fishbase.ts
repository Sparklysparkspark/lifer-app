// Follow-up cross-check for the ~186K (region, species, country) vagrant flags that
// verify-vagrant-flags.ts (GBIF /distributions) couldn't resolve either way. 86% of the species
// still in that queue are ray-finned fish (actinopterygii) — GBIF's distributions endpoint is
// mostly bird/mammal-checklist sourced (IOC, IUCN) and rarely has fish coverage, so a second,
// fish-specific authoritative source is needed rather than re-trying the same one.
//
// FishBase publishes exactly this: a per-species per-country native/introduced/endemic/stray
// status table (`country.parquet`), joined to ISO2 codes via `countref.parquet`. It's a static
// snapshot hosted on source.coop (no auth, no rate limit, unlike GBIF downloads or iNaturalist's
// heavily-throttled check_lists endpoint) — confirmed live: one bulk fetch covers all countries
// and all species at once, no per-country or per-species calls needed.
//
// Same conservative policy as verify-vagrant-flags.ts: only clear the vagrant flag on an
// unambiguous presence signal (native/endemic/introduced/established/reintroduced). FishBase's
// own "stray" status is a genuine confirmation of vagrancy (not an unresolved case) so it's
// recorded as a confirmed-vagrant override rather than left to search. Everything murkier
// (questionable/misidentification/error/not established/extirpated, or no FishBase record at
// all) is left exactly where it was — logged to VAGRANT_STILL_NEEDS_SEARCH_LOG — rather than
// guessed at, since none of those statuses actually confirm current native/introduced presence.
//
// Idempotent per species via species_traits.fishbase_checked_at (087_fishbase_checked_at.sql).
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import duckdb from "duckdb";
import { pool } from "../db.js";
import { fetchAllCountries } from "data-pipeline/src/fetch/fetch-region-boundary.js";

const FISHBASE_RELEASE = "v26.06";
const FISHBASE_BASE_URL = `https://data.source.coop/cboettig/fishbase/fb/${FISHBASE_RELEASE}/parquet`;
const FISHBASE_CACHE_DIR = path.join(process.env.HOME ?? ".", ".cache", "lifer-fishbase");

const NEEDS_SEARCH_LOG = "/Users/judahstarkey/.claude/jobs/d9ace272/tmp/vagrant-needs-search.jsonl";
const STILL_NEEDS_SEARCH_LOG = "/Users/judahstarkey/.claude/jobs/d9ace272/tmp/vagrant-still-needs-search.jsonl";

interface NeedsSearchEntry {
  regionId: string;
  speciesId: string;
  scientificName: string;
  country: string;
  continent: string;
}

// Statuses that confirm the species genuinely belongs in this country's checklist (as either a
// native or an established non-native population) — see this file's header comment for why
// "stray" and the other statuses are handled separately rather than lumped in here.
const PRESENCE_STATUSES = new Set(["native", "endemic", "introduced", "established", "reintroduced"]);

async function ensureFishbaseTablesCached(): Promise<void> {
  mkdirSync(FISHBASE_CACHE_DIR, { recursive: true });
  for (const table of ["country", "countref", "species"]) {
    const dest = path.join(FISHBASE_CACHE_DIR, `${table}.parquet`);
    if (existsSync(dest)) continue;
    console.log(`[verify-vagrant-fishbase] downloading ${table}.parquet...`);
    const res = await fetch(`${FISHBASE_BASE_URL}/${table}.parquet`);
    if (!res.ok) throw new Error(`FishBase fetch failed for ${table}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
  }
}

interface FishbaseStatusRow {
  iso2: string;
  sci_name: string;
  status: string;
}

async function loadFishbaseStatusTable(): Promise<Map<string, FishbaseStatusRow[]>> {
  const db = new duckdb.Database(":memory:");
  const con = db.connect();
  const countryParquet = path.join(FISHBASE_CACHE_DIR, "country.parquet");
  const countrefParquet = path.join(FISHBASE_CACHE_DIR, "countref.parquet");
  const speciesParquet = path.join(FISHBASE_CACHE_DIR, "species.parquet");

  const rows = await new Promise<FishbaseStatusRow[]>((resolve, reject) => {
    con.all(
      `SELECT r.ISO2Alpha AS iso2, (s.Genus || ' ' || s.Species) AS sci_name, lower(c.Status) AS status
       FROM '${countryParquet}' c
       JOIN '${countrefParquet}' r ON c.C_Code = r.C_Code
       JOIN '${speciesParquet}' s ON c.SpecCode = s.SpecCode
       WHERE r.ISO2Alpha IS NOT NULL`,
      (err: Error | null, result: unknown) => {
        if (err) reject(err);
        else resolve(result as FishbaseStatusRow[]);
      },
    );
  });
  con.close();

  const byKey = new Map<string, FishbaseStatusRow[]>();
  for (const row of rows) {
    const key = `${row.iso2}|${row.sci_name}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(row);
  }
  return byKey;
}

async function main() {
  if (!existsSync(NEEDS_SEARCH_LOG)) {
    throw new Error(`${NEEDS_SEARCH_LOG} not found — run verify-vagrant-flags.ts first`);
  }
  writeFileSync(STILL_NEEDS_SEARCH_LOG, "");

  await ensureFishbaseTablesCached();
  console.log("[verify-vagrant-fishbase] loading FishBase country-status table...");
  const fishbaseByKey = await loadFishbaseStatusTable();
  console.log(`[verify-vagrant-fishbase] ${fishbaseByKey.size} distinct (country, species) FishBase entries loaded`);

  const countries = await fetchAllCountries();
  const iso2ByName = new Map(countries.filter((c) => c.iso2).map((c) => [c.name, c.iso2 as string]));

  const entries: NeedsSearchEntry[] = readFileSync(NEEDS_SEARCH_LOG, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const speciesIds = [...new Set(entries.map((e) => e.speciesId))];
  const speciesRes = await pool.query<{ id: string; taxon_class: string }>(
    `SELECT id, taxon_class FROM species WHERE id = ANY($1)`,
    [speciesIds],
  );
  const taxonClassById = new Map(speciesRes.rows.map((r) => [r.id, r.taxon_class]));

  let cleared = 0;
  let confirmedStray = 0;
  let stillNeedsSearch = 0;
  let notFish = 0;

  for (const entry of entries) {
    if (taxonClassById.get(entry.speciesId) !== "actinopterygii") {
      notFish++;
      appendFileSync(STILL_NEEDS_SEARCH_LOG, JSON.stringify(entry) + "\n");
      continue;
    }
    const iso2 = iso2ByName.get(entry.country);
    const matches = iso2 ? fishbaseByKey.get(`${iso2}|${entry.scientificName}`) : undefined;

    if (!matches || matches.length === 0) {
      stillNeedsSearch++;
      appendFileSync(STILL_NEEDS_SEARCH_LOG, JSON.stringify(entry) + "\n");
      continue;
    }

    const statuses = new Set(matches.map((m) => m.status));
    const hasPresence = [...statuses].some((s) => PRESENCE_STATUSES.has(s));

    if (hasPresence) {
      await pool.query(
        `INSERT INTO region_species_manual_overrides (region_id, species_id, is_vagrant, source)
         VALUES ($1, $2, false, $3)
         ON CONFLICT (region_id, species_id) DO UPDATE SET is_vagrant = false, source = EXCLUDED.source`,
        [entry.regionId, entry.speciesId, "fishbase:status:" + [...statuses].join(",")],
      );
      await pool.query(`UPDATE region_species SET is_vagrant = false WHERE region_id = $1 AND species_id = $2`, [
        entry.regionId,
        entry.speciesId,
      ]);
      cleared++;
    } else if (statuses.has("stray")) {
      await pool.query(
        `INSERT INTO region_species_manual_overrides (region_id, species_id, is_vagrant, source)
         VALUES ($1, $2, true, 'fishbase:confirmed-stray')
         ON CONFLICT (region_id, species_id) DO UPDATE SET is_vagrant = true, source = EXCLUDED.source`,
        [entry.regionId, entry.speciesId],
      );
      confirmedStray++;
    } else {
      // questionable / misidentification / error / not established / extirpated — none of these
      // confirm current native or introduced presence, so this stays unresolved rather than
      // guessing either way.
      stillNeedsSearch++;
      appendFileSync(STILL_NEEDS_SEARCH_LOG, JSON.stringify({ ...entry, fishbaseStatuses: [...statuses] }) + "\n");
    }
  }

  await pool.query(
    `UPDATE species_traits SET fishbase_checked_at = now()
     WHERE species_id = ANY($1) AND fishbase_checked_at IS NULL`,
    [speciesIds.filter((id) => taxonClassById.get(id) === "actinopterygii")],
  );

  console.log(
    `[verify-vagrant-fishbase] done. ${entries.length} entries processed: ` +
      `${cleared} cleared, ${confirmedStray} confirmed as real vagrants, ` +
      `${stillNeedsSearch} still unresolved, ${notFish} non-fish passed through unchanged.`,
  );
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
