// Finds catalog species that iNaturalist has split, and records which species they became
// (species_splits, migration 118). iNaturalist retires a split taxon and points it at the ones that
// replaced it; a catalog entry still on the retired taxon is the old, wider species. Installs
// re-file their photos under it by place (apps/api species/speciesSplits.ts).
//
// For each retired taxon a catalog species is on:
// - two or more replacements: a split. The replacements the catalog has become its new species.
//   One named like the old entry means the old entry lives on as that one (Phrynosoma coronatum,
//   now only Baja's), so it takes that taxon and stays;
// - one replacement the catalog has as another species: the same species twice, written to the
//   review file for species-merges.tsv (merges are vetted, never automatic);
// - replacements the catalog doesn't have: written to the review file, for the catalog stage to add.
//
// Taxon lookups are cached (data/inat-taxon-status-cache.json) and reused while younger than
// LIFER_INAT_CACHE_MAX_AGE_DAYS (90 by default), so a rerun asks iNaturalist only for what's new.
//
// Usage: npx tsx src/scripts/find-species-splits.ts [--apply]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { inatGet } from "../inatApi.js";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const CACHE_PATH = path.join(DATA_DIR, "inat-taxon-status-cache.json");
const REVIEW_PATH = path.join(DATA_DIR, "review", "inat-taxon-changes.tsv");
const MAX_AGE_MS = Number(process.env.LIFER_INAT_CACHE_MAX_AGE_DAYS ?? 90) * 86_400_000;
const BATCH = 30;

interface TaxonStatus {
  name: string;
  active: boolean;
  current: number[];
  at: number;
}
type Cache = Record<string, TaxonStatus | null>;

function loadCache(): Cache {
  return existsSync(CACHE_PATH) ? (JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Cache) : {};
}

/** Looks up every id not cached (or cached too long ago), 30 a request. */
async function lookUp(ids: number[], cache: Cache, log: (m: string) => void): Promise<void> {
  const now = Date.now();
  const todo = [...new Set(ids)].filter((id) => {
    const c = cache[String(id)];
    return c === undefined || (c !== null && now - c.at > MAX_AGE_MS);
  });
  if (todo.length > 0) log(`[splits] looking up ${todo.length} taxa on iNaturalist (${Math.ceil(todo.length / BATCH)} requests)`);
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const d = await inatGet<{ results: Array<{ id: number; name: string; is_active: boolean; current_synonymous_taxon_ids?: number[] | null }> }>(
      `https://api.inaturalist.org/v1/taxa/${batch.join(",")}`,
    );
    const got = new Map(d.results.map((t) => [t.id, t]));
    for (const id of batch) {
      const t = got.get(id);
      cache[String(id)] = t ? { name: t.name, active: t.is_active, current: t.current_synonymous_taxon_ids ?? [], at: Date.now() } : null;
    }
    // Saved as it goes, so an interrupted run keeps what it fetched.
    if ((i / BATCH) % 20 === 0 || i + BATCH >= todo.length) writeFileSync(CACHE_PATH, JSON.stringify(cache));
    if ((i / BATCH) % 200 === 0) log(`[splits] ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
  }
}

export interface SplitFindings {
  splits: number;
  splitRows: number;
  mergeCandidates: number;
  missing: number;
}

export async function findSpeciesSplits(apply: boolean, log: (m: string) => void = console.log): Promise<SplitFindings> {
  const species = await pool.query<{ id: string; scientific_name: string; inat_taxon_id: number }>(
    `SELECT id, scientific_name, inat_taxon_id FROM species WHERE inat_taxon_id IS NOT NULL AND NOT is_other_taxa`,
  );
  const names = await pool.query<{ species_id: string; name: string }>(
    `SELECT id AS species_id, scientific_name AS name FROM species WHERE NOT is_other_taxa
     UNION ALL SELECT species_id, synonym_name FROM species_synonyms`,
  );
  const byInat = new Map<number, string>();
  for (const s of species.rows) if (!byInat.has(s.inat_taxon_id)) byInat.set(s.inat_taxon_id, s.id);
  const byName = new Map<string, string>();
  for (const n of names.rows) if (!byName.has(n.name.toLowerCase())) byName.set(n.name.toLowerCase(), n.species_id);

  const cache = loadCache();
  await lookUp(species.rows.map((s) => s.inat_taxon_id), cache, log);
  // The replacements' names too, to match them to catalog species under any name.
  const retired = species.rows.filter((s) => cache[String(s.inat_taxon_id)]?.active === false);
  await lookUp(retired.flatMap((s) => cache[String(s.inat_taxon_id)]!.current), cache, log);

  const rows: Array<{ parent: string; daughter: string }> = [];
  const retaxon: Array<{ id: string; inat: number }> = [];
  const review: string[] = ["kind\tspecies\tinat_taxon_id\treplaced_by\tin_catalog"];
  let splits = 0;
  let mergeCandidates = 0;
  let missing = 0;
  for (const s of retired) {
    const current = cache[String(s.inat_taxon_id)]!.current;
    if (current.length === 0) continue;
    const targets = current.map((id) => {
      const t = cache[String(id)];
      const speciesId = byInat.get(id) ?? (t ? byName.get(t.name.toLowerCase()) : undefined);
      return { id, name: t?.name ?? String(id), speciesId };
    });
    const describe = targets.map((t) => `${t.name} (${t.id})`).join(", ");
    const inCatalog = targets.map((t) => (t.speciesId ? "yes" : "no")).join(",");
    if (current.length === 1) {
      const [t] = targets;
      if (t.speciesId && t.speciesId !== s.id) {
        mergeCandidates++;
        review.push(`merge\t${s.scientific_name}\t${s.inat_taxon_id}\t${describe}\t${inCatalog}`);
      } else if (!t.speciesId) {
        missing++;
        review.push(`rename\t${s.scientific_name}\t${s.inat_taxon_id}\t${describe}\t${inCatalog}`);
      }
      continue;
    }
    splits++;
    // Named like the old entry: the old entry is that one now, still valid where it lives.
    const sameName = targets.find((t) => t.name.toLowerCase() === s.scientific_name.toLowerCase());
    if (sameName) retaxon.push({ id: s.id, inat: sameName.id });
    for (const t of targets) {
      if (t === sameName) continue;
      if (!t.speciesId) missing++;
      else if (t.speciesId !== s.id) rows.push({ parent: s.id, daughter: t.speciesId });
    }
    review.push(`split\t${s.scientific_name}\t${s.inat_taxon_id}\t${describe}\t${inCatalog}`);
  }

  mkdirSync(path.dirname(REVIEW_PATH), { recursive: true });
  writeFileSync(REVIEW_PATH, review.join("\n") + "\n");
  log(
    `[splits] ${splits} split species (${rows.length} new-species links), ${mergeCandidates} possible duplicates, ` +
      `${missing} replacements the catalog lacks; details in ${path.relative(process.cwd(), REVIEW_PATH)}`,
  );

  if (apply) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Only parents judged this run: one renamed onto its same-name taxon below is no longer
      // retired next run, and its splits must survive that.
      await client.query(`DELETE FROM species_splits WHERE source = 'inaturalist' AND parent_species_id = ANY($1)`, [retired.map((s) => s.id)]);
      if (rows.length > 0) {
        await client.query(
          `INSERT INTO species_splits (parent_species_id, daughter_species_id, source)
           SELECT DISTINCT p, d, 'inaturalist' FROM unnest($1::uuid[], $2::uuid[]) AS v(p, d)
           ON CONFLICT DO NOTHING`,
          [rows.map((r) => r.parent), rows.map((r) => r.daughter)],
        );
      }
      // Only where no other catalog species is already on that taxon.
      for (const r of retaxon) {
        await client.query(
          `UPDATE species SET inat_taxon_id = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM species WHERE inat_taxon_id = $2 AND id <> $1)`,
          [r.id, r.inat],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    log("[splits] applied");
  }
  return { splits, splitRows: rows.length, mergeCandidates, missing };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  findSpeciesSplits(process.argv.includes("--apply"))
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
