// Makes iNaturalist's preferred English common name the display name of every non-bird species
// with an iNaturalist taxon id (birds keep eBird's names). A species iNaturalist has no English
// name for, or whose taxon is inactive or unknown there, keeps its current name. The name being
// replaced moves into common_name_aliases, so search and keyword matching still find it (the
// species_search_names triggers pick the change up). Renamed species lose their CLIP text
// embedding, which the refresh command's vectors stage then recomputes from the new name.
//
// iNaturalist names come from disk first: data/inat-common-names-cache/names.json (this script's
// own locale=en answers) and then data/inat-taxa-cache.json (add-missing-species.ts). Only taxa in
// neither are fetched, 200 per request, paced by the shared iNaturalist client and saved as it
// goes, so a rerun fetches nothing twice.
//
// data/reference/common-name-overrides.json (scientific name -> display name) is the manual
// choice: it beats iNaturalist's name, keeps both it and the old name as aliases, and is never
// held back; a shared name is only reported as a collision.
//
// A rename that would give two species of one taxon class the same display name is held back:
// that species keeps its name, gains iNaturalist's as an alias, and is listed for review in
// data/review/inat-common-name-collisions.tsv.
//
// Usage (from packages/data-pipeline):
//   npm run apply-inat-common-names                  (fetch what's missing, preview)
//   npm run apply-inat-common-names -- --offline     (names already on disk only)
//   npm run apply-inat-common-names -- --apply       (backup, then write under the catalog lock)
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pool } from "../db.js";
import { toTitleCase } from "../fetch/fetch-gbif-vernacular.js";
import { inatGet } from "../inatApi.js";
import { cachedPlaceCounts } from "../regions/inatChecklist.js";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const NAMES_CACHE = path.join(DATA_DIR, "inat-common-names-cache", "names.json");
const TAXA_CACHE = path.join(DATA_DIR, "inat-taxa-cache.json");
const COLLISIONS_TSV = path.join(DATA_DIR, "review", "inat-common-name-collisions.tsv");
const PLAN_TSV = path.join(DATA_DIR, "build", "inat-common-names-plan.tsv");
const OVERRIDES = path.join(DATA_DIR, "reference", "common-name-overrides.json");
const LOCK_DIR = "/tmp/lifer-catalog-write.lock";

export interface NameRow {
  id: string;
  scientific_name: string;
  common_name: string | null;
  common_name_aliases: string[] | null;
  taxon_class: string;
  inat_taxon_id: number | null;
}

/** iNaturalist's answer for a taxon; null when it doesn't know the id. */
export type InatName = { name: string | null; active: boolean } | null;

export type Outcome = "changed" | "kept" | "no-inat-name" | "held";

export interface Planned {
  row: NameRow;
  outcome: Outcome;
  name: string | null;
  aliases: string[];
  pinned?: boolean;
}

/** Existing aliases, then the name being replaced, case-insensitively unique, minus the new name. */
export function mergeAliases(aliases: string[] | null, oldName: string | null, newName: string): string[] {
  const seen = new Set([newName.toLowerCase()]);
  const out: string[] = [];
  for (const a of [...(aliases ?? []), oldName ?? ""]) {
    const t = a.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

const classKey = (cls: string, name: string | null) => (name ? `${cls}\t${name.toLowerCase()}` : null);

/** Decides every row's name. Birds and rows without a taxon id are kept as they are, and still
 *  count when checking for shared names. */
export function planNames(
  rows: NameRow[],
  names: Map<number, InatName>,
  observations: Map<number, number> = new Map(),
  overrides: Record<string, string> = {},
): Planned[] {
  const plan: Planned[] = rows.map((row) => {
    const keep = { row, name: row.common_name, aliases: row.common_name_aliases ?? [] };
    const pinned = overrides[row.scientific_name]?.trim();
    if (pinned) {
      if (pinned === row.common_name) return { ...keep, outcome: "kept", pinned: true };
      const inat = row.inat_taxon_id === null ? undefined : names.get(row.inat_taxon_id);
      const viaInat = inat?.active && inat.name?.trim() ? toTitleCase(inat.name.trim()) : null;
      const aliases = mergeAliases(mergeAliases(row.common_name_aliases, row.common_name, pinned), viaInat, pinned);
      return { row, outcome: "changed", name: pinned, aliases, pinned: true };
    }
    if (row.taxon_class === "aves" || row.inat_taxon_id === null) return { ...keep, outcome: "kept" };
    const inat = names.get(row.inat_taxon_id);
    const raw = inat?.active ? inat.name?.trim() : undefined;
    if (!raw) return { ...keep, outcome: "no-inat-name" };
    const name = toTitleCase(raw);
    if (name === row.common_name) return { ...keep, outcome: "kept" };
    return { row, outcome: "changed", name, aliases: mergeAliases(row.common_name_aliases, row.common_name, name) };
  });

  // Hold back renames that land on a name another species of the class shows; repeat, since
  // holding one back restores its old name, which another rename may have taken. When iNaturalist
  // gives every member the name and one is observed 5 times more than the rest, that one keeps it.
  const moving = (p: Planned) =>
    p.outcome === "changed" && !p.pinned && p.name!.toLowerCase() !== p.row.common_name?.toLowerCase();
  const obs = (p: Planned) => observations.get(p.row.inat_taxon_id!) ?? 0;
  for (;;) {
    const byKey = new Map<string, Planned[]>();
    for (const p of plan) {
      const k = classKey(p.row.taxon_class, p.name);
      if (k) byKey.set(k, [...(byKey.get(k) ?? []), p]);
    }
    let held = 0;
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      const [top, second] = [...group].sort((a, b) => obs(b) - obs(a));
      const winner = group.every(moving) && obs(top) >= 5 * obs(second) && obs(top) > 0 ? top : null;
      for (const p of group) {
        if (p === winner || !moving(p)) continue;
        const inatName = p.name!;
        p.outcome = "held";
        p.name = p.row.common_name;
        p.aliases = mergeAliases(p.row.common_name_aliases, inatName, p.name ?? "");
        held++;
      }
    }
    if (!held) return plan;
  }
}

/** Held renames with the species already showing the name iNaturalist gives them. */
export function collisions(plan: Planned[], names: Map<number, InatName>) {
  const shown = new Map<string, Planned[]>();
  for (const p of plan) {
    const k = classKey(p.row.taxon_class, p.name);
    if (k) shown.set(k, [...(shown.get(k) ?? []), p]);
  }
  return plan
    .filter((p) => p.outcome === "held")
    .map((p) => {
      const wanted = toTitleCase(names.get(p.row.inat_taxon_id!)!.name!.trim());
      const holders = shown.get(classKey(p.row.taxon_class, wanted)!) ?? [];
      return { p, wanted, holders };
    });
}

type NamesCache = Record<string, InatName>;

function loadJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
}

function saveNamesCache(cache: NamesCache) {
  mkdirSync(path.dirname(NAMES_CACHE), { recursive: true });
  writeFileSync(`${NAMES_CACHE}.tmp`, JSON.stringify(cache));
  renameSync(`${NAMES_CACHE}.tmp`, NAMES_CACHE);
}

/** Names on disk, own cache first; the ids neither cache has are returned as missing. */
export function namesOnDisk(ids: number[], own: NamesCache, taxa: Record<string, unknown>) {
  const names = new Map<number, InatName>();
  const missing: number[] = [];
  let fromOwn = 0;
  let fromTaxa = 0;
  for (const id of ids) {
    if (String(id) in own) {
      names.set(id, own[String(id)]);
      fromOwn++;
      continue;
    }
    const t = taxa[String(id)] as { common?: string | null; active?: boolean } | null | undefined;
    if (t === undefined) {
      missing.push(id);
      continue;
    }
    names.set(id, t ? { name: t.common ?? null, active: t.active !== false } : null);
    fromTaxa++;
  }
  return { names, missing, fromOwn, fromTaxa };
}

/** Each taxon's highest research-grade count in any cached place (refresh-inat-counts.ts). */
function observationPeaks() {
  const peaks = new Map<number, number>();
  const dir = path.join(DATA_DIR, "inat-species-counts-cache");
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    for (const [id, t] of cachedPlaceCounts(Number(path.basename(file, ".json"))) ?? [])
      if (t.count > (peaks.get(id) ?? 0)) peaks.set(id, t.count);
  }
  return peaks;
}

const BATCH = 200;

async function fetchNames(ids: number[], cache: NamesCache) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // v2 takes 200 ids and returns only the fields asked for: a tenth of v1's requests.
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const url = `https://api.inaturalist.org/v2/taxa?id=${batch.join(",")}&fields=id,name,is_active,preferred_common_name&locale=en&per_page=${BATCH}`;
    type Taxon = { id: number; name: string; is_active?: boolean; preferred_common_name?: string };
    let d: { results: Taxon[] } | undefined;
    // The shared client already honours Retry-After; after it gives up, back off hard.
    for (let attempt = 1; !d; attempt++) {
      try {
        const started = Date.now();
        d = await inatGet<{ results: Taxon[] }>(url);
        // A slow answer means the client retried (usually a 429): give other iNaturalist users room.
        if (Date.now() - started > 10_000) await sleep(60_000);
      } catch (err) {
        saveNamesCache(cache);
        if (attempt >= 5) throw err;
        console.warn(`[inat-common-names] ${(err as Error).message}; waiting ${attempt * 5} min`);
        await sleep(attempt * 300_000);
      }
    }
    const got = new Map(d.results.map((t) => [t.id, t]));
    for (const id of batch) {
      const t = got.get(id);
      cache[String(id)] = t ? { name: t.preferred_common_name ?? null, active: t.is_active !== false } : null;
    }
    if ((i / BATCH) % 10 === 0) {
      saveNamesCache(cache);
      console.log(`[inat-common-names] fetched ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
    }
  }
  saveNamesCache(cache);
}

const tsv = (cells: Array<string | null | undefined>) => cells.map((c) => (c ?? "").replace(/[\t\n]/g, " ")).join("\t");

async function lock() {
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      return;
    } catch {
      console.log("[inat-common-names] catalog write lock busy, retrying in 30 s");
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
}

async function main() {
  const { values } = parseArgs({ options: { apply: { type: "boolean" }, offline: { type: "boolean" } } });
  const offline = values.offline || process.env.LIFER_INAT_OFFLINE === "1";

  const loadRows = async () =>
    (
      await pool.query<NameRow>(
        `SELECT id, scientific_name, common_name, common_name_aliases, taxon_class, inat_taxon_id
         FROM species WHERE taxon_class <> 'aves' ORDER BY scientific_name, id`,
      )
    ).rows;
  let rows = await loadRows();
  const ids = [...new Set(rows.flatMap((r) => (r.inat_taxon_id === null ? [] : [r.inat_taxon_id])))];
  const own = loadJson<NamesCache>(NAMES_CACHE, {});
  let disk = namesOnDisk(ids, own, loadJson(TAXA_CACHE, {}));
  console.log(
    `[inat-common-names] ${ids.length} iNaturalist taxa: ${disk.fromTaxa} from inat-taxa-cache, ${disk.fromOwn} from inat-common-names-cache, ${disk.missing.length} missing`,
  );
  if (disk.missing.length && !offline) {
    await fetchNames(disk.missing, own);
    disk = namesOnDisk(ids, own, loadJson(TAXA_CACHE, {}));
  }
  if (disk.missing.length)
    console.log(`[inat-common-names] ${disk.missing.length} taxa still unknown, kept as they are`);

  const observations = observationPeaks();
  const overrides = loadJson<Record<string, string>>(OVERRIDES, {});
  const plan = planNames(rows, disk.names, observations, overrides);
  for (const p of plan.filter((q) => q.pinned)) {
    const k = classKey(p.row.taxon_class, p.name);
    const clash = plan.filter((q) => q !== p && classKey(q.row.taxon_class, q.name) === k);
    if (clash.length)
      console.warn(
        `[inat-common-names] COLLISION: override "${p.name}" for ${p.row.scientific_name} is also shown by ${clash.map((q) => q.row.scientific_name).join(", ")}`,
      );
  }
  const count = (o: Outcome) =>
    plan.filter((p) => p.outcome === o && p.row.inat_taxon_id !== null && p.row.taxon_class !== "aves").length;
  console.log(
    `[inat-common-names] changed ${count("changed")}, kept ${count("kept")}, no iNaturalist name ${count("no-inat-name")}, held back (shared name) ${count("held")}`,
  );
  const perClass = new Map<string, Record<Outcome, number>>();
  for (const p of plan) {
    if (p.row.inat_taxon_id === null) continue;
    const c = perClass.get(p.row.taxon_class) ?? { changed: 0, kept: 0, "no-inat-name": 0, held: 0 };
    c[p.outcome]++;
    perClass.set(p.row.taxon_class, c);
  }
  for (const [cls, c] of [...perClass].sort()) console.log(`  ${cls.padEnd(24)} ${JSON.stringify(c)}`);

  const changed = plan.filter((p) => p.outcome === "changed" || p.outcome === "held");
  const spot = changed.filter((p) => p.row.scientific_name === "Smilisca baudinii");
  const step = Math.max(1, Math.floor(changed.length / 39));
  for (let i = 0; spot.length < 40 && i < changed.length; i += step)
    if (!spot.includes(changed[i])) spot.push(changed[i]);
  console.log("[inat-common-names] spot checks (scientific name: old -> new [aliases]):");
  for (const p of spot)
    console.log(
      `  ${p.row.scientific_name} (${p.row.taxon_class}): ${p.row.common_name ?? "(none)"} -> ${p.name} [${p.aliases.join("; ")}]`,
    );

  const coll = collisions(plan, disk.names);
  mkdirSync(path.dirname(COLLISIONS_TSV), { recursive: true });
  writeFileSync(
    COLLISIONS_TSV,
    [
      "taxon_class\tscientific_name\tinat_taxon_id\tkept_name\tinat_name\talready_shown_by",
      ...coll.map((c) =>
        tsv([
          c.p.row.taxon_class,
          c.p.row.scientific_name,
          String(c.p.row.inat_taxon_id),
          c.p.name,
          c.wanted,
          c.holders.map((h) => h.row.scientific_name).join(", "),
        ]),
      ),
    ].join("\n") + "\n",
  );
  mkdirSync(path.dirname(PLAN_TSV), { recursive: true });
  writeFileSync(
    PLAN_TSV,
    [
      "outcome\ttaxon_class\tscientific_name\told_name\tnew_name\taliases",
      ...changed.map((p) =>
        tsv([p.outcome, p.row.taxon_class, p.row.scientific_name, p.row.common_name, p.name, p.aliases.join("; ")]),
      ),
    ].join("\n") + "\n",
  );
  console.log(
    `[inat-common-names] ${coll.length} held back for a shared name, in ${path.relative(DATA_DIR, COLLISIONS_TSV)}; full plan in ${path.relative(DATA_DIR, PLAN_TSV)}`,
  );

  if (!values.apply) {
    console.log("[inat-common-names] preview only; rerun with --apply to write");
    return;
  }
  await lock();
  try {
    // Reread under the lock: another writer may have renamed something since the preview.
    rows = await loadRows();
    const writes = planNames(rows, disk.names, observations, overrides).filter(
      (p) => p.name !== p.row.common_name || p.aliases.join("\n") !== (p.row.common_name_aliases ?? []).join("\n"),
    );
    const backup = path.join(DATA_DIR, "backups", `species-names-before-inat-common-names-${Date.now()}.json`);
    mkdirSync(path.dirname(backup), { recursive: true });
    writeFileSync(
      backup,
      JSON.stringify(
        writes.map((p) => ({
          id: p.row.id,
          common_name: p.row.common_name,
          common_name_aliases: p.row.common_name_aliases,
        })),
      ),
    );
    console.log(`[inat-common-names] backed up ${writes.length} rows to ${path.relative(DATA_DIR, backup)}`);
    await writeNames(writes);
    console.log(`[inat-common-names] applied ${writes.length} rows`);
  } finally {
    rmdirSync(LOCK_DIR);
  }
}

/** Writes names and aliases in one transaction. */
export async function writeNames(writes: Planned[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < writes.length; i += 5000) {
      const chunk = writes.slice(i, i + 5000).map((p) => ({ id: p.row.id, name: p.name, aliases: p.aliases }));
      await client.query(
        `UPDATE species s SET common_name = v.name,
           common_name_aliases = CASE WHEN jsonb_array_length(v.aliases) = 0 THEN NULL
                                      ELSE ARRAY(SELECT jsonb_array_elements_text(v.aliases)) END
         FROM jsonb_to_recordset($1::jsonb) AS v(id uuid, name text, aliases jsonb)
         WHERE s.id = v.id`,
        [JSON.stringify(chunk)],
      );
    }
    // The CLIP text vector is "a photo of a <common name>"; the vectors stage refills missing ones.
    const renamed = writes.filter((p) => p.name !== p.row.common_name).map((p) => p.row.id);
    const dropped = await client.query(`DELETE FROM species_text_embeddings WHERE species_id = ANY($1::uuid[])`, [
      renamed,
    ]);
    console.log(
      `[inat-common-names] ${dropped.rowCount} text embeddings of renamed species dropped for the vectors stage`,
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
