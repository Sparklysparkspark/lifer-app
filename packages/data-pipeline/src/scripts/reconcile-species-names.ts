// Links catalog species to the names GBIF, iNaturalist and eBird use today.
//
// The catalog's scientific names come from an older GBIF backbone, while GBIF downloads now use
// the Catalogue of Life and eBird and iNaturalist follow their own taxonomies. Checklist steps
// compare names exactly, so a renamed species would otherwise silently drop off.
//
// Three stages, each writing species_synonyms rows (with a source) or filling an id:
//   col    Catalog species that never appear under their own name in the cached GBIF country
//          downloads get their Catalogue of Life accepted name as a synonym.
//   inat   Species without an iNaturalist id get one from iNat's taxon search, which matches old
//          names ("matched_term"). A species iNat split out of a catalog species becomes a
//          synonym of it too, so its records still count.
//   ebird  Birds without an eBird code are matched in data/reference/ebird-taxonomy.csv by
//          scientific name, by any synonym, then by an unambiguous common name.
//
// Never links one name or id to two catalog species (that means a source merged species the
// catalog keeps apart); those are listed in the report instead.
//
//   npx tsx src/scripts/reconcile-species-names.ts --zip-names <names.tsv> [--stage col,inat,ebird]
//     [--inat-limit N] [--checkpoint <progress.jsonl>] [--history-invertebrates] [--apply] [--report <out.json>]
//   npx tsx src/scripts/reconcile-species-names.ts --apply-report <reviewed-report.json>
// <names.tsv>: "name<TAB>class<TAB>records" for every species name in the cached country zips.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { mapWithConcurrency } from "../concurrency.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EBIRD_TAXONOMY_CSV = path.join(__dirname, "..", "..", "data", "reference", "ebird-taxonomy.csv");
const COL_MATCH_URL = "https://api.checklistbank.org/dataset/3LXR/match/nameusage";
const INAT_TAXA_URL = "https://api.inaturalist.org/v1/taxa";
const INAT_CHANGES_URL = "https://www.inaturalist.org/taxon_changes.json";
const HISTORY_VERTEBRATE_CLASSES = new Set([
  "Aves", "Mammalia", "Reptilia", "Amphibia",
  "Myxini", "Petromyzonti", "Elasmobranchii", "Holocephali", "Coelacanthi", "Dipneusti", "Actinopterygii", "Teleostei",
  "Chondrostei", "Cladistii", "Holostei",
]);
// GBIF classes (as the country downloads spell them) whose species the catalog carries.
const HISTORY_GBIF_CLASSES = new Set([
  "Aves", "Mammalia", "Reptilia", "Amphibia",
  "Myxini", "Petromyzonti", "Elasmobranchii", "Holocephali", "Coelacanthi", "Dipneusti", "Actinopterygii", "Teleostei",
  "Chondrostei", "Cladistii", "Holostei",
  "Anthozoa", "Hydrozoa", "Scyphozoa", "Cubozoa", "Staurozoa", "Echinoidea", "Asteroidea", "Ophiuroidea", "Holothuroidea",
  "Crinoidea", "Gastropoda", "Bivalvia", "Polyplacophora", "Scaphopoda", "Cephalopoda", "Malacostraca", "Copepoda",
  "Thecostraca", "Demospongiae", "Hexactinellida", "Calcarea", "Ascidiacea",
]);
const USER_AGENT = "Lifer catalog builder (github.com/Sparklysparkspark/lifer-app)";
// iNaturalist asks API users to stay around one request a second.
const INAT_DELAY_MS = 1100;

interface CatalogSpecies {
  id: string;
  scientific_name: string;
  common_name: string | null;
  taxon_class: string | null;
  inat_taxon_id: number | null;
  ebird_code: string | null;
  occurrence_count: number | null;
}

interface Proposal {
  stage: "col" | "inat" | "ebird";
  speciesId: string;
  catalogName: string;
  kind: "synonym" | "inat_taxon_id" | "ebird_code";
  value: string;
  note?: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, attempt = 0): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  // Refused for going too fast (429): wait a full minute each time, since quick retries only
  // spend more of iNaturalist's daily allowance.
  if (res.status === 429 && attempt < 30) {
    await sleep(60_000);
    return getJson(url, attempt + 1);
  }
  if (res.status >= 500 && attempt < 5) {
    await sleep(2000 * 2 ** attempt);
    return getJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

/** Catalogue of Life's accepted species name for `name`, when `name` is a synonym there. */
export async function colAcceptedName(name: string): Promise<string | null> {
  const d = await getJson(`${COL_MATCH_URL}?scientificName=${encodeURIComponent(name)}`);
  const u = d?.usage;
  if (!u || u.status === "accepted") return null;
  const acceptedSpecies = (u.classification ?? []).find((c: any) => c.rank === "species" && c.status === "accepted");
  const accepted = acceptedSpecies?.name ?? u.accepted?.name?.scientificName ?? null;
  return accepted && accepted !== name ? accepted : null;
}

/** iNaturalist's current species for a name (it matches old names too, via "matched_term"). */
export function readInatResults(name: string, results: any[]): { id: number; name: string } | null {
  const lower = name.toLowerCase();
  const exactMatches = results.filter(
    (r) =>
      r.rank === "species" &&
      r.is_active !== false &&
      ((r.matched_term ?? "").toLowerCase() === lower || String(r.name).toLowerCase() === lower),
  );
  return exactMatches.length === 1 ? { id: exactMatches[0].id, name: exactMatches[0].name } : null;
}

/** The names a taxon came from, walking back through iNaturalist's committed renames, splits and
 * merges ("taxon changes"), nearest first, up to `maxDepth` steps. */
export async function inatAncestorNames(
  taxonId: number,
  fetchChanges: (taxonId: number) => Promise<any[]>,
  maxDepth = 3,
): Promise<Array<{ name: string; depth: number }>> {
  const out: Array<{ name: string; depth: number }> = [];
  const seen = new Set<number>([taxonId]);
  let frontier = [taxonId];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const change of await fetchChanges(id)) {
        if (change.status && change.status !== "committed") continue;
        if (!(change.output_taxa ?? []).some((t: any) => t.id === id)) continue;
        for (const input of change.input_taxa ?? []) {
          if (seen.has(input.id)) continue;
          seen.add(input.id);
          out.push({ name: input.name, depth });
          next.push(input.id);
        }
      }
    }
    frontier = next;
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function main() {
  const reviewed = arg("apply-report");
  if (reviewed) {
    const { proposals } = JSON.parse(readFileSync(reviewed, "utf8")) as { proposals: Proposal[] };
    await applyProposals(proposals, true);
    await pool.end();
    return;
  }
  const zipNamesPath = arg("zip-names");
  const stages = new Set((arg("stage") ?? "col,inat,history,ebird").split(","));
  const apply = process.argv.includes("--apply");
  const inatLimit = Number(arg("inat-limit") ?? "5000");
  const reportPath = arg("report") ?? "reconcile-species-names-report.json";

  const catalog = (
    await pool.query<CatalogSpecies>(
      `SELECT s.id, s.scientific_name, s.common_name, s.taxon_class, s.inat_taxon_id::int AS inat_taxon_id, s.ebird_code,
              t.occurrence_count::int AS occurrence_count
         FROM species s LEFT JOIN species_traits t ON t.species_id = s.id
        WHERE s.is_other_taxa = false`,
    )
  ).rows;
  // --only "Name one,Name two" limits the stages to those catalog species (for checking a fix).
  const only = arg("only")?.split(",").map((n) => n.trim());
  const byName = new Map(catalog.map((s) => [s.scientific_name, s]));
  const scope = only ? catalog.filter((s) => only.includes(s.scientific_name)) : catalog;
  const synonymOwner = new Map(
    (await pool.query<{ synonym_name: string; species_id: string }>(`SELECT synonym_name, species_id FROM species_synonyms`)).rows.map((r) => [
      r.synonym_name,
      r.species_id,
    ]),
  );
  const proposals: Proposal[] = [];
  const conflicts: Array<Record<string, string>> = [];
  // --checkpoint <file.jsonl>: every result and finished item is appended as it happens, and a
  // rerun with the same file carries on where the last one stopped (the name services are slow).
  const checkpointPath = arg("checkpoint");
  const finished = new Set<string>();
  if (checkpointPath && existsSync(checkpointPath)) {
    for (const line of readFileSync(checkpointPath, "utf8").split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line) as { t: "p" | "c" | "d"; v?: any; k?: string };
      if (entry.t === "d") finished.add(entry.k!);
      else if (entry.t === "c") conflicts.push(entry.v);
      else {
        const prop = entry.v as Proposal;
        proposals.push(prop);
        // Replay into the working state, so conflict checks and skips see earlier results.
        if (prop.kind === "synonym") synonymOwner.set(prop.value, prop.speciesId);
        const sp = catalog.find((c) => c.id === prop.speciesId);
        if (sp && prop.kind === "inat_taxon_id") sp.inat_taxon_id = Number(prop.value);
        if (sp && prop.kind === "ebird_code") sp.ebird_code = prop.value;
      }
    }
    // Failed lookups recorded as finished are retried.
    for (const c of conflicts) {
      if (!/^\d{3} for /.test(c.reason ?? "")) continue;
      const sp = c.catalogName ? catalog.find((x) => x.scientific_name === c.catalogName) : null;
      if (sp) finished.delete(`${c.stage}:${sp.id}`);
      if (c.stage === "history" && c.name) finished.delete(`history:${c.name}`);
    }
    console.log(`[checkpoint] carrying on: ${proposals.length} results and ${finished.size} finished items from ${checkpointPath}`);
  }
  const record = (entry: object) => {
    if (checkpointPath) appendFileSync(checkpointPath, `${JSON.stringify(entry)}\n`);
  };
  const recordedPush = <T,>(list: T[], t: "p" | "c") => {
    const push = list.push.bind(list);
    list.push = (...items: T[]) => {
      for (const v of items) record({ t, v });
      return push(...items);
    };
  };
  recordedPush(proposals, "p");
  recordedPush(conflicts, "c");
  const finish = (key: string) => {
    finished.add(key);
    record({ t: "d", k: key });
  };

  // A name may link to a catalog species only if it isn't already a different species' name or
  // synonym (that would merge two catalog species).
  function proposeSynonym(stage: Proposal["stage"], s: CatalogSpecies, name: string, note?: string) {
    if (name === s.scientific_name) return;
    const owner = byName.get(name)?.id ?? synonymOwner.get(name);
    if (owner && owner !== s.id) {
      conflicts.push({ stage, catalogName: s.scientific_name, name, reason: `already names ${byName.get(name) ? "catalog species" : "a synonym of"} ${owner}` });
      return;
    }
    if (owner === s.id) return;
    synonymOwner.set(name, s.id);
    proposals.push({ stage, speciesId: s.id, catalogName: s.scientific_name, kind: "synonym", value: name, note });
  }

  // --- col ---
  if (stages.has("col")) {
    if (!zipNamesPath) throw new Error("--zip-names is required for the col stage");
    const zipNames = new Set<string>();
    for (const line of readFileSync(zipNamesPath, "utf8").split("\n")) {
      const name = line.split("\t")[0];
      if (name) zipNames.add(name);
    }
    const missing = scope.filter((s) => !zipNames.has(s.scientific_name));
    console.log(`[col] ${missing.length} of ${catalog.length} catalog species never appear under their own name in the GBIF downloads`);
    let done = 0;
    await mapWithConcurrency(missing, 6, async (s) => {
      if (finished.has(`col:${s.id}`)) return;
      let ok = true;
      try {
        const accepted = await colAcceptedName(s.scientific_name);
        // Only worth linking when the data actually uses the accepted name.
        if (accepted && zipNames.has(accepted)) proposeSynonym("col", s, accepted);
      } catch (err) {
        conflicts.push({ stage: "col", catalogName: s.scientific_name, reason: (err as Error).message });
        ok = false;
      }
      if (ok) finish(`col:${s.id}`);
      if (++done % 1000 === 0) console.log(`[col] ${done}/${missing.length}, ${proposals.length} links so far`);
    });
    console.log(`[col] ${proposals.filter((p) => p.stage === "col").length} links`);
  }

  // --- inat ---
  if (stages.has("inat")) {
    const takenInatIds = new Map(catalog.filter((s) => s.inat_taxon_id != null).map((s) => [s.inat_taxon_id!, s.id]));
    // Most-recorded first, so a limited run fixes the species people actually see. Finished ones
    // are left out before the limit, so a rerun moves on to the next batch.
    const todo = scope
      .filter((s) => s.inat_taxon_id == null && !finished.has(`inat:${s.id}`))
      .sort((a, b) => (b.occurrence_count ?? 0) - (a.occurrence_count ?? 0))
      .slice(0, inatLimit);
    console.log(`[inat] resolving ${todo.length} species without an iNaturalist id`);
    let done = 0;
    for (const s of todo) {
      if (finished.has(`inat:${s.id}`)) continue;
      let ok = true;
      try {
        const d = await getJson(`${INAT_TAXA_URL}?q=${encodeURIComponent(s.scientific_name)}&per_page=10`);
        const exact = readInatResults(s.scientific_name, d.results ?? []);
        if (exact) {
          const owner = takenInatIds.get(exact.id);
          if (owner && owner !== s.id) {
            conflicts.push({ stage: "inat", catalogName: s.scientific_name, name: exact.name, reason: `iNat ${exact.id} already on ${owner}` });
          } else {
            takenInatIds.set(exact.id, s.id);
            proposals.push({ stage: "inat", speciesId: s.id, catalogName: s.scientific_name, kind: "inat_taxon_id", value: String(exact.id) });
            proposeSynonym("inat", s, exact.name);
          }
        }
      } catch (err) {
        conflicts.push({ stage: "inat", catalogName: s.scientific_name, reason: (err as Error).message });
        ok = false;
      }
      if (ok) finish(`inat:${s.id}`);
      if (++done % 250 === 0) console.log(`[inat] ${done}/${todo.length}, ${proposals.filter((p) => p.stage === "inat").length} results so far`);
      await sleep(INAT_DELAY_MS);
    }
  }

  // --- history ---
  // Names in the GBIF data that still match nothing: walk back through iNaturalist's recorded
  // renames and splits to the catalog species they came from. Following the real history, rather
  // than a matched subspecies name, keeps species the catalog already has separately on their own entry.
  if (stages.has("history")) {
    if (!zipNamesPath) throw new Error("--zip-names is required for the history stage");
    const minRecords = Number(arg("history-min-records") ?? "20");
    // Vertebrates only unless asked: that's where splits matter most, and marine invertebrates
    // add thousands of slow lookups.
    const includeInvertebrates = process.argv.includes("--history-invertebrates");
    const recordsByName = new Map<string, number>();
    for (const line of readFileSync(zipNamesPath, "utf8").split("\n")) {
      const [name, cls, records] = line.split("\t");
      if (!name || !(includeInvertebrates ? HISTORY_GBIF_CLASSES : HISTORY_VERTEBRATE_CLASSES).has(cls)) continue;
      recordsByName.set(name, (recordsByName.get(name) ?? 0) + Number(records || 0));
    }
    const unmatched = [...recordsByName.entries()]
      .filter(([name, records]) => records >= minRecords && !byName.has(name) && !synonymOwner.has(name) && name.includes(" "))
      .sort((a, b) => b[1] - a[1])
      .slice(0, Number(arg("history-limit") ?? "20000"));
    console.log(`[history] ${unmatched.length} names in the GBIF data with ${minRecords}+ records match no catalog species`);
    const fetchChanges = async (taxonId: number) => {
      await sleep(INAT_DELAY_MS);
      const d = await getJson(`${INAT_CHANGES_URL}?taxon_id=${taxonId}`);
      return Array.isArray(d) ? d : [];
    };
    let done = 0;
    for (const [name] of unmatched) {
      if (finished.has(`history:${name}`)) continue;
      let ok = true;
      try {
        await sleep(INAT_DELAY_MS);
        const found = readInatResults(name, (await getJson(`${INAT_TAXA_URL}?q=${encodeURIComponent(name)}&per_page=10`)).results ?? []);
        if (found) {
          const ancestors = await inatAncestorNames(found.id, fetchChanges);
          // The nearest step back that reaches the catalog decides; two species there is a merge.
          for (let depth = 1; depth <= 3; depth++) {
            const owners = new Set(
              ancestors
                .filter((a) => a.depth === depth)
                .map((a) => byName.get(a.name)?.id ?? synonymOwner.get(a.name))
                .filter((id): id is string => !!id),
            );
            if (owners.size === 1) {
              const target = catalog.find((c) => c.id === [...owners][0])!;
              proposeSynonym("inat", target, name, `from iNaturalist history, ${depth} step${depth === 1 ? "" : "s"} back`);
              break;
            }
            if (owners.size > 1) {
              conflicts.push({ stage: "history", name, reason: `came from ${owners.size} catalog species (a merge)` });
              break;
            }
          }
        }
      } catch (err) {
        conflicts.push({ stage: "history", name, reason: (err as Error).message });
        ok = false;
      }
      if (ok) finish(`history:${name}`);
      if (++done % 100 === 0) console.log(`[history] ${done}/${unmatched.length}, ${proposals.filter((p) => p.note?.startsWith("from iNaturalist history")).length} links so far`);
    }
  }

  // --- ebird ---
  if (stages.has("ebird")) {
    const lines = readFileSync(EBIRD_TAXONOMY_CSV, "utf8").split("\n");
    const header = parseCsvLine(lines[0]);
    const col = (n: string) => header.indexOf(n);
    const bySci = new Map<string, string>();
    const byCommon = new Map<string, string[]>();
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const f = parseCsvLine(line);
      if (f[col("CATEGORY")] !== "species") continue;
      const code = f[col("SPECIES_CODE")];
      bySci.set(f[col("SCIENTIFIC_NAME")].toLowerCase(), code);
      const common = f[col("COMMON_NAME")].toLowerCase();
      byCommon.set(common, [...(byCommon.get(common) ?? []), code]);
    }
    const takenCodes = new Map(catalog.filter((s) => s.ebird_code).map((s) => [s.ebird_code!, s.id]));
    const namesOf = new Map<string, string[]>();
    for (const [name, id] of synonymOwner) namesOf.set(id, [...(namesOf.get(id) ?? []), name]);
    for (const s of scope.filter((c) => c.taxon_class === "aves" && !c.ebird_code)) {
      const candidates = [s.scientific_name, ...(namesOf.get(s.id) ?? [])];
      let code = candidates.map((n) => bySci.get(n.toLowerCase())).find(Boolean) ?? null;
      let how = "scientific name";
      if (!code && s.common_name) {
        const commonMatches = byCommon.get(s.common_name.toLowerCase().split(",")[0].trim());
        if (commonMatches?.length === 1) {
          code = commonMatches[0];
          how = "common name";
        }
      }
      if (!code) continue;
      const owner = takenCodes.get(code);
      if (owner && owner !== s.id) {
        conflicts.push({ stage: "ebird", catalogName: s.scientific_name, name: code, reason: `eBird ${code} already on ${owner}` });
        continue;
      }
      takenCodes.set(code, s.id);
      proposals.push({ stage: "ebird", speciesId: s.id, catalogName: s.scientific_name, kind: "ebird_code", value: code, note: `by ${how}` });
    }
    console.log(`[ebird] ${proposals.filter((p) => p.stage === "ebird").length} codes`);
  }

  writeFileSync(reportPath, JSON.stringify({ proposals, conflicts }, null, 1));
  console.log(`Report: ${reportPath} (${proposals.length} proposals, ${conflicts.length} conflicts or errors)`);

  await applyProposals(proposals, apply);
  await pool.end();
}

/** Writes proposals to the database (only with `apply`). Also used by --apply-report, to apply a
 * report that was already reviewed without asking the name services again. */
async function applyProposals(proposals: Proposal[], apply: boolean): Promise<void> {
  if (apply) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const p of proposals) {
        if (p.kind === "synonym") {
          await client.query(
            `INSERT INTO species_synonyms (species_id, synonym_name, source) VALUES ($1, $2, $3) ON CONFLICT (synonym_name) DO NOTHING`,
            [p.speciesId, p.value, p.stage],
          );
        } else if (p.kind === "inat_taxon_id") {
          await client.query(`UPDATE species SET inat_taxon_id = $2 WHERE id = $1 AND inat_taxon_id IS NULL`, [p.speciesId, Number(p.value)]);
        } else {
          await client.query(`UPDATE species SET ebird_code = $2 WHERE id = $1 AND ebird_code IS NULL`, [p.speciesId, p.value]);
        }
      }
      await client.query("COMMIT");
      console.log(`Applied ${proposals.length} changes.`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
}
