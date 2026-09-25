// Flags fossil-only species (and older extinctions IUCN never assessed) as fully_extinct, the
// same flag check-extinction-status.ts sets from IUCN. IUCN only covers species that went
// extinct in recorded history, so a Miocene osprey (Pandion lovensis, which iNaturalist even
// labels "Osprey") or a whole genus of fossil penguins sails straight past that check.
//
// Signal: GBIF's species/{key}/speciesProfiles, where each checklist constituent that knows the
// species reports extinct true/false. The Paleobiology Database, the Catalogue of Life and
// Clements all show up there. A species counts as extinct only when at least one source says
// extinct AND no source says extant (Emperor Penguin carries extinct=false from PBDB, COL and
// Clements, so a lone stray true can't flip a living species).
//
// Two extra guards before flagging, both reported as "ambiguous" instead of flagged:
//   - the species is on a region checklist (a real regional list includes it, so a human
//     should look before hiding it), or
//   - GBIF has human/machine observations of it since 1990 (rediscovered, or a name collision).
//
// Candidates: species on no region checklist with at most 5 GBIF records (where fossils
// hide), plus every species sharing its common name with another species (a fossil sharing a
// living species' name also forces an ugly "Osprey (Pandion haliaetus)" folder name).
//
// Resumable: every GBIF response is cached under data/raw/, so a rerun only calls GBIF for
// species it hasn't seen. Dry run by default; pass --apply to write the flags.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";
import { RAW_DIR } from "data-pipeline/src/raw-cache.js";

const CONCURRENCY = 4;
const CACHE_DIR = path.join(RAW_DIR, "gbif-species-profiles");
const RECENT_OBS_CACHE_DIR = path.join(RAW_DIR, "gbif-recent-observations");
// Sources whose extinct flag is trusted on its own (it still loses to any source saying extant).
const TAXONOMIC_SOURCES = new Set(["The Paleobiology Database", "Catalogue of Life", "World Register of Marine Species"]);

async function fetchJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt <= 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": "Lifer/0.7 (https://github.com/Sparklysparkspark/lifer-app)" } });
    } catch (err) {
      console.error(`  network error (attempt ${attempt}) ${url}:`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      console.error(`  ${res.status} for ${url}, backing off ${Math.round(delayMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    if (!res.ok) return null;
    return (await res.json()) as T;
  }
  console.error(`  giving up on ${url} after retries`);
  return null;
}

// Cached per key on disk: a null (failed) fetch is NOT cached, so a rerun retries it.
async function cachedJson<T>(dir: string, key: string, url: string): Promise<T | null> {
  const file = path.join(dir, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8")) as T;
  const data = await fetchJson<T>(url);
  if (data !== null) writeFileSync(file, JSON.stringify(data));
  return data;
}

interface Profiles {
  results: Array<{ extinct?: boolean; source?: string }>;
}

async function extinctVotes(gbifKey: string): Promise<{ extinct: string[]; extant: string[] } | null> {
  const data = await cachedJson<Profiles>(CACHE_DIR, gbifKey, `https://api.gbif.org/v1/species/${gbifKey}/speciesProfiles?limit=100`);
  if (!data) return null;
  const withFlag = data.results.filter((r) => typeof r.extinct === "boolean");
  return {
    extinct: [...new Set(withFlag.filter((r) => r.extinct).map((r) => r.source ?? "unknown source"))],
    extant: [...new Set(withFlag.filter((r) => !r.extinct).map((r) => r.source ?? "unknown source"))],
  };
}

async function recentObservationCount(gbifKey: string): Promise<number | null> {
  const url =
    `https://api.gbif.org/v1/occurrence/search?taxonKey=${gbifKey}` +
    `&basisOfRecord=HUMAN_OBSERVATION&basisOfRecord=MACHINE_OBSERVATION&year=1990,2100&limit=0`;
  const data = await cachedJson<{ count: number }>(RECENT_OBS_CACHE_DIR, gbifKey, url);
  return data ? data.count : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  // --names=Pandion lovensis,Pandion haliaetus checks exactly those species (used to validate
  // the signal on known fossils and known living species before a full run).
  const namesArg = process.argv.find((a) => a.startsWith("--names="));
  const names = namesArg ? namesArg.slice("--names=".length).split(",").map((n) => n.trim()) : null;
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(RECENT_OBS_CACHE_DIR, { recursive: true });

  const res = await pool.query<{
    species_id: string;
    gbif_key: string;
    scientific_name: string;
    common_name: string | null;
    on_checklist: boolean;
  }>(
    `SELECT s.id AS species_id, s.gbif_key, s.scientific_name, s.common_name,
            EXISTS (SELECT 1 FROM region_species rs WHERE rs.species_id = s.id) AS on_checklist
       FROM species s
       JOIN species_traits t ON t.species_id = s.id
      WHERE s.gbif_key IS NOT NULL
        AND t.fully_extinct = false
        AND ${
          names
            ? `s.scientific_name = ANY($1)`
            : `((NOT EXISTS (SELECT 1 FROM region_species rs WHERE rs.species_id = s.id) AND COALESCE(t.occurrence_count, 0) <= 5)
               OR (s.common_name IS NOT NULL AND EXISTS (SELECT 1 FROM species s2 WHERE s2.common_name = s.common_name AND s2.id <> s.id)))`
        }
      ORDER BY s.scientific_name
      ${limit ? `LIMIT ${limit}` : ""}`,
    names ? [names] : [],
  );
  console.log(`[check-fossil] ${res.rows.length} candidates${apply ? "" : " (dry run, pass --apply to write flags)"}`);

  let checked = 0;
  let failed = 0;
  let flagged = 0;
  const ambiguous: string[] = [];
  await mapWithConcurrency(res.rows, CONCURRENCY, async (row) => {
    const label = `${row.common_name ?? row.scientific_name} (${row.scientific_name})`;
    const votes = await extinctVotes(row.gbif_key);
    checked++;
    if (checked % 500 === 0) console.log(`[check-fossil] ${checked}/${res.rows.length} (${flagged} flagged, ${ambiguous.length} ambiguous)`);
    if (!votes) {
      failed++;
      return;
    }
    if (names) console.log(`  ${label}: extinct per [${votes.extinct.join(", ")}], extant per [${votes.extant.join(", ")}]`);
    if (votes.extinct.length === 0) return;
    if (votes.extant.length > 0) {
      ambiguous.push(`${label}: extinct per ${votes.extinct.join(", ")}; extant per ${votes.extant.join(", ")}`);
      return;
    }
    // Clements alone lags rediscoveries: it still marks the Black-browed Babbler extinct,
    // though it was found alive in Borneo in 2020. Needs a taxonomic source to agree.
    if (!votes.extinct.some((source) => TAXONOMIC_SOURCES.has(source))) {
      ambiguous.push(`${label}: extinct per ${votes.extinct.join(", ")} only`);
      return;
    }
    if (row.on_checklist) {
      ambiguous.push(`${label}: extinct per ${votes.extinct.join(", ")}, but on a region checklist`);
      return;
    }
    const recent = await recentObservationCount(row.gbif_key);
    if (recent === null) {
      failed++;
      return;
    }
    if (recent > 0) {
      ambiguous.push(`${label}: extinct per ${votes.extinct.join(", ")}, but ${recent} observations since 1990`);
      return;
    }
    if (apply) await pool.query(`UPDATE species_traits SET fully_extinct = true WHERE species_id = $1`, [row.species_id]);
    console.log(`  EXTINCT: ${label} per ${votes.extinct.join(", ")}`);
    flagged++;
  });

  if (ambiguous.length > 0) {
    console.log(`[check-fossil] ${ambiguous.length} ambiguous, NOT flagged:`);
    for (const line of ambiguous) console.log(`  ${line}`);
  }
  console.log(
    `[check-fossil] done. ${checked} checked, ${flagged} ${apply ? "newly flagged" : "would be flagged"} extinct, ` +
      `${ambiguous.length} ambiguous, ${failed} failed (rerun to retry those).`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
