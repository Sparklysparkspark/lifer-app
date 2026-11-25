// Official country checklists, starting with FishBase's fish (iNaturalist barely covers fish, so
// its lists miss most of a country's species). Pilot only: reads, caches and reports, never
// writes to a database. Plan: docs/plans/official-checklists.md.
//
// Source: the rfishbase snapshot of FishBase's own tables (CC BY-NC 4.0, FishBase.org team),
// https://huggingface.co/datasets/cboettig/fishbase. A handful of parquet files, fetched once
// each (one at a time, paced, retried with backoff) instead of scraping fishbase.se per country.
// Cached in data/official-checklists-cache/fishbase-<version>/; a rerun downloads nothing.
//
// Usage (from packages/data-pipeline):
//   npx tsx src/scripts/fetch-official-checklists.ts                       (Japan and Colombia)
//   npx tsx src/scripts/fetch-official-checklists.ts --countries=392,170,76 --version=v25.04
//   npx tsx src/scripts/fetch-official-checklists.ts --compare             (plus read-only catalog report)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import duckdb from "duckdb";
import { pool } from "@lifer/core/db.js";
import { httpFetch } from "@lifer/core/lib/http.js";

const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIR = path.join(PIPELINE_DIR, "data");
const CACHE_DIR = path.join(DATA_DIR, "official-checklists-cache");
const BASE = "https://huggingface.co/datasets/cboettig/fishbase/resolve/main/data/fb";
const TABLES = ["country", "countref", "species", "synonyms", "families"] as const;

/** One row of a country checklist, as cached. */
export interface OfficialRow {
  name: string;
  specCode: number;
  fbClass: string;
  family: string;
  status: string;
  presence: string;
  fresh: boolean;
  brack: boolean;
  salt: boolean;
  depthDeep: number | null;
  demersPelag: string;
  synonyms: string[];
}

const COLUMNS: Array<keyof OfficialRow> = [
  "name",
  "specCode",
  "fbClass",
  "family",
  "status",
  "presence",
  "fresh",
  "brack",
  "salt",
  "depthDeep",
  "demersPelag",
  "synonyms",
];

export function rowsToTsv(rows: OfficialRow[]): string {
  const cell = (r: OfficialRow, k: keyof OfficialRow) => {
    const v = r[k];
    if (Array.isArray(v)) return v.join("|");
    if (typeof v === "boolean") return v ? "1" : "0";
    return v == null ? "" : String(v);
  };
  return [COLUMNS.join("\t"), ...rows.map((r) => COLUMNS.map((k) => cell(r, k)).join("\t"))].join("\n") + "\n";
}

export function tsvToRows(text: string): OfficialRow[] {
  const [, ...lines] = text.trimEnd().split("\n");
  return lines.map((line) => {
    const c = line.split("\t");
    return {
      name: c[0],
      specCode: Number(c[1]),
      fbClass: c[2],
      family: c[3],
      status: c[4],
      presence: c[5],
      fresh: c[6] === "1",
      brack: c[7] === "1",
      salt: c[8] === "1",
      depthDeep: c[9] === "" ? null : Number(c[9]),
      demersPelag: c[10],
      synonyms: c[11] ? c[11].split("|") : [],
    };
  });
}

async function download(version: string, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const table of TABLES) {
    const file = path.join(dir, `${table}.parquet`);
    if (existsSync(file)) continue;
    const url = `${BASE}/${version}/parquet/${table}.parquet`;
    console.log(`download ${url}`);
    const res = await httpFetch(url, {
      maxRetries: 6,
      retryServerErrors: true,
      backoffBaseMs: 5_000,
      backoffMaxMs: 120_000,
      paceMs: 3_000,
      timeoutMs: 300_000,
    });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    // Written whole then renamed, so a killed run never leaves a truncated file behind.
    writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
    renameSync(`${file}.part`, file);
  }
}

function duck() {
  const db = new duckdb.Database(":memory:");
  const all = <T>(sql: string) =>
    new Promise<T[]>((ok, fail) => db.all(sql, (e: Error | null, rows: unknown[]) => (e ? fail(e) : ok(rows as T[]))));
  const close = () => new Promise<void>((ok) => db.close(() => ok()));
  return { all, close };
}

const truthy = (v: unknown) => v === true || v === -1 || v === 1 || v === "-1" || v === "1";

async function extractCountry(dir: string, cCode: string): Promise<OfficialRow[]> {
  const db = duck();
  const p = (t: string) => `read_parquet('${path.join(dir, `${t}.parquet`)}')`;
  // FishBase stores country codes as zero-padded text ('392', '076'); compare as integers.
  const rows = await db.all<Record<string, unknown>>(`
    WITH syn AS (
      SELECT SpecCode, list(DISTINCT trim(SynGenus) || ' ' || trim(SynSpecies)) AS names
      FROM ${p("synonyms")}
      WHERE lower(Status) IN ('synonym', 'accepted name', 'provisionally accepted name')
        AND SynGenus IS NOT NULL AND SynSpecies IS NOT NULL
      GROUP BY SpecCode)
    SELECT trim(s.Genus) || ' ' || trim(s.Species) AS name, s.SpecCode AS specCode,
           f.Class AS fbClass, f.Family AS family, c.Status AS status, c.CurrentPresence AS presence,
           s.Fresh AS fresh, s.Brack AS brack, s.Saltwater AS salt, s.DepthRangeDeep AS depthDeep,
           s.DemersPelag AS demersPelag, syn.names AS synonyms
    FROM ${p("country")} c
    JOIN ${p("species")} s ON s.SpecCode = c.SpecCode
    LEFT JOIN ${p("families")} f ON f.FamCode = s.FamCode
    LEFT JOIN syn ON syn.SpecCode = s.SpecCode
    WHERE TRY_CAST(c.C_Code AS INTEGER) = ${Number(cCode)}
    ORDER BY name`);
  await db.close();
  const seen = new Set<string>();
  return rows
    .map((r) => ({
      name: String(r.name),
      specCode: Number(r.specCode),
      fbClass: String(r.fbClass ?? ""),
      family: String(r.family ?? ""),
      status: String(r.status ?? "").toLowerCase(),
      presence: String(r.presence ?? "").toLowerCase(),
      fresh: truthy(r.fresh),
      brack: truthy(r.brack),
      salt: truthy(r.salt),
      depthDeep: r.depthDeep == null ? null : Number(r.depthDeep),
      demersPelag: String(r.demersPelag ?? "").toLowerCase(),
      synonyms: ((r.synonyms as string[] | null) ?? []).filter((n) => n !== String(r.name)).sort(),
    }))
    .filter((r) => !seen.has(r.name) && seen.add(r.name));
}

// ---- Comparison with the catalog (read-only) ------------------------------------------------

export type StatusGroup = "confirmed" | "possible" | "rejected";

/** FishBase's country status: native, endemic and introduced are confirmed; questionable and
 *  stray are possible; misidentification, error, not established and extirpated say "not here". */
export function statusGroup(status: string): StatusGroup {
  if (["native", "endemic", "introduced"].includes(status)) return "confirmed";
  if (["questionable", "stray"].includes(status)) return "possible";
  return "rejected";
}

export function habitat(r: Pick<OfficialRow, "fresh" | "brack" | "salt">): "freshwater" | "marine" | "both" {
  if (r.salt && !r.fresh) return "marine";
  if (r.fresh && !r.salt) return "freshwater";
  // Brackish-only counts as marine: those fish live in estuaries and lagoons, the sea zones' edge.
  return r.fresh ? "both" : "marine";
}

/** Deep-water fish nobody has photographed: hidden by default when listed (the proposal's flag). */
export function isUnseenDeepSea(r: OfficialRow, openPhotos: number): boolean {
  return habitat(r) === "marine" && r.demersPelag.startsWith("bathy") && openPhotos === 0;
}

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export interface CatalogSpecies {
  id: string;
  name: string;
  fish: boolean;
  synonyms: string[];
}

export interface CatalogIndex {
  byName: Map<string, string>;
  /** Catalog synonym to species id; null where two species claim the same synonym. */
  bySynonym: Map<string, string | null>;
  fishByGenus: Map<string, string[]>;
  fishByEpithet: Map<string, string[]>;
}

export function buildIndex(species: CatalogSpecies[]): CatalogIndex {
  const idx: CatalogIndex = {
    byName: new Map(),
    bySynonym: new Map(),
    fishByGenus: new Map(),
    fishByEpithet: new Map(),
  };
  const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const s of species) {
    idx.byName.set(s.name, s.id);
    for (const syn of s.synonyms) {
      const had = idx.bySynonym.get(syn);
      idx.bySynonym.set(syn, had === undefined || had === s.id ? s.id : null);
    }
    const [genus, epithet] = s.name.split(" ");
    if (s.fish && epithet) {
      push(idx.fishByGenus, genus, s.name);
      push(idx.fishByEpithet, epithet, s.name);
    }
  }
  return idx;
}

export interface Match {
  kind: "exact" | "synonym" | "fuzzy" | "none";
  speciesId: string | null;
  via: string;
}

/** Matches a FishBase name to a catalog species: the exact name, then synonyms either side, then a
 *  unique fish name one spelling step away. `fbAccepted` holds every FishBase valid name, so a
 *  synonym or near spelling that FishBase treats as its own species is never taken. */
export function matchOfficial(
  row: Pick<OfficialRow, "name" | "synonyms">,
  idx: CatalogIndex,
  fbAccepted: Set<string>,
): Match {
  const exact = idx.byName.get(row.name);
  if (exact) return { kind: "exact", speciesId: exact, via: row.name };
  const viaCatalog = idx.bySynonym.get(row.name);
  if (viaCatalog) return { kind: "synonym", speciesId: viaCatalog, via: row.name };
  for (const syn of row.synonyms) {
    if (fbAccepted.has(syn)) continue;
    const id = idx.byName.get(syn) ?? idx.bySynonym.get(syn);
    if (id) return { kind: "synonym", speciesId: id, via: syn };
  }
  const [genus, epithet] = row.name.split(" ");
  if (!epithet) return { kind: "none", speciesId: null, via: "" };
  const near = new Set([
    ...(idx.fishByGenus.get(genus) ?? []).filter((n) => {
      const e = n.split(" ")[1];
      return e.slice(0, 3) === epithet.slice(0, 3) && levenshtein(e, epithet) <= 2;
    }),
    ...(idx.fishByEpithet.get(epithet) ?? []).filter((n) => levenshtein(n.split(" ")[0], genus) <= 1),
  ]);
  const candidates = [...near].filter((n) => n !== row.name && !fbAccepted.has(n));
  if (candidates.length === 1) return { kind: "fuzzy", speciesId: idx.byName.get(candidates[0])!, via: candidates[0] };
  return { kind: "none", speciesId: null, via: "" };
}

const PUBLISHED_EVIDENCE = "published-2026-10-08";

async function compareCountry(dir: string, cCode: string, rows: OfficialRow[]): Promise<void> {
  const db = duck();
  const [ref] = await db.all<{ name: string; iso3: string }>(
    `SELECT PAESE AS name, ISO3Alpha AS iso3 FROM read_parquet('${path.join(dir, "countref.parquet")}')
     WHERE TRY_CAST(C_Code AS INTEGER) = ${Number(cCode)}`,
  );
  const accepted = await db.all<{ n: string }>(
    `SELECT DISTINCT trim(Genus) || ' ' || trim(Species) AS n FROM read_parquet('${path.join(dir, "species.parquet")}')`,
  );
  const fbAccepted = new Set(accepted.map((r) => r.n));
  // Open (CC0, CC BY) research-grade iNaturalist photos anywhere, from open-vectors' index.
  const candidates = path.join(DATA_DIR, "open-vectors", "candidates.parquet");
  const photoRows = existsSync(candidates)
    ? await db.all<{ n: string; c: bigint }>(
        `SELECT taxon_name AS n, count(*) AS c FROM read_parquet('${candidates}') GROUP BY 1`,
      )
    : [];
  const openPhotos = new Map(photoRows.map((r) => [r.n, Number(r.c)]));
  await db.close();
  const photosOf = (r: OfficialRow) => Math.max(0, ...[r.name, ...r.synonyms].map((n) => openPhotos.get(n) ?? 0));

  const client = await pool.connect();
  try {
    // Never writes: the maintainer database may be mid-pipeline.
    await client.query("BEGIN READ ONLY");
    const region = (
      await client.query<{ id: string; zones: string[] }>(
        `SELECT id, coalesce(nearby_sea_zone_ids, '{}') AS zones FROM regions
         WHERE external_codes @> ARRAY[$1]::text[] AND home_country_id IS NULL LIMIT 1`,
        [ref.iso3],
      )
    ).rows[0];
    const species = (
      await client.query<{ id: string; name: string; fish: boolean; synonyms: string[]; has_photo: boolean }>(
        `SELECT s.id, s.scientific_name AS name, s.taxon_class = 'actinopterygii' AS fish,
                s.reference_photo IS NOT NULL AS has_photo,
                coalesce(array_agg(y.synonym_name) FILTER (WHERE y.synonym_name IS NOT NULL), '{}') AS synonyms
         FROM species s LEFT JOIN species_synonyms y ON y.species_id = s.id GROUP BY s.id`,
      )
    ).rows;
    const country = new Map(
      (
        await client.query<{ species_id: string; is_vagrant: boolean; evidence_source: string | null }>(
          `SELECT rs.species_id, rs.is_vagrant, rs.evidence_source FROM region_species rs
           JOIN species s ON s.id = rs.species_id AND s.taxon_class = 'actinopterygii' WHERE rs.region_id = $1`,
          [region.id],
        )
      ).rows.map((r) => [r.species_id, r]),
    );
    const zone = new Set(
      (
        await client.query<{ species_id: string }>(
          `SELECT DISTINCT zs.species_id FROM sea_zone_species zs
           JOIN species s ON s.id = zs.species_id AND s.taxon_class = 'actinopterygii' WHERE zs.sea_zone_id = ANY($1)`,
          [region.zones],
        )
      ).rows.map((r) => r.species_id),
    );
    const restored = new Map(
      (
        await client.query<{ species_id: string; n: number }>(
          `WITH RECURSIVE tree AS (SELECT id FROM regions WHERE id = $1
             UNION SELECT r.id FROM regions r JOIN tree t ON r.parent_id = t.id)
           SELECT rs.species_id, count(*)::int AS n FROM region_species rs
           JOIN species s ON s.id = rs.species_id AND s.taxon_class = 'actinopterygii'
           WHERE rs.region_id IN (SELECT id FROM tree) AND rs.evidence_source = $2 GROUP BY 1`,
          [region.id, PUBLISHED_EVIDENCE],
        )
      ).rows.map((r) => [r.species_id, r.n]),
    );
    await client.query("ROLLBACK");

    const idx = buildIndex(species);
    const byId = new Map(species.map((s) => [s.id, s]));
    const packFile = path.join(DATA_DIR, "published-packs-cache", `${ref.name.toLowerCase()}-actinopterygii.json`);
    const published = existsSync(packFile)
      ? new Set((JSON.parse(readFileSync(packFile, "utf8")).country as Array<{ name: string }>).map((e) => e.name))
      : new Set<string>();

    const tally: Record<string, number> = {};
    const add = (k: string, n = 1) => (tally[k] = (tally[k] ?? 0) + n);
    const matchedIds = new Map<string, StatusGroup>();
    const lines = [
      "name\tstatus\tgroup\thabitat\tdemers_pelag\tdepth_deep\tmatch\tcatalog_name\tcountry\tsea_zone\tpublished\topen_photos\tunseen_deep_sea",
    ];
    for (const r of rows) {
      const g = statusGroup(r.status);
      const h = habitat(r);
      const m = matchOfficial(r, idx, fbAccepted);
      const photos = photosOf(r);
      const tail = isUnseenDeepSea(r, photos);
      const listed = m.speciesId ? country.get(m.speciesId) : undefined;
      const inZone = m.speciesId ? zone.has(m.speciesId) : false;
      const catalogName = m.speciesId ? byId.get(m.speciesId)!.name : "";
      if (m.speciesId && (matchedIds.get(m.speciesId) ?? "rejected") === "rejected") matchedIds.set(m.speciesId, g);
      add(`status ${r.status}`);
      add(`${g} ${h}`);
      add(`${g} match ${m.kind}`);
      if (g !== "rejected") {
        if (!m.speciesId) {
          add(`${g} not in catalog`);
          if (photos > 0) add(`${g} not in catalog, open photo`);
          if (tail) add(`${g} not in catalog, unseen deep-sea`);
        } else if (listed || inZone) {
          add(
            `${g} already listed${listed?.is_vagrant ? " (country, vagrant)" : listed ? " (country)" : " (sea zone only)"}`,
          );
        } else {
          add(`${g} in catalog, would add`);
          add(`${g} in catalog, would add ${h}`);
          if (byId.get(m.speciesId)!.has_photo) add(`${g} in catalog, would add, has reference photo`);
          if (tail) add(`${g} in catalog, would add, unseen deep-sea`);
        }
      } else if (listed) add(`rejected but listed in country (${r.status})`);
      if (published.has(catalogName) || published.has(r.name)) add(`${g} in published 2026-10-08 pack`);
      lines.push(
        [
          r.name,
          r.status,
          g,
          h,
          r.demersPelag,
          r.depthDeep ?? "",
          m.kind,
          catalogName,
          listed ? (listed.is_vagrant ? "vagrant" : "listed") : "",
          inZone ? "1" : "",
          published.has(catalogName) || published.has(r.name) ? "1" : "",
          photos,
          tail ? "1" : "",
        ].join("\t"),
      );
    }
    for (const [id, row] of country) {
      const g = matchedIds.get(id);
      const key = g ? `catalog country row, FishBase ${g}` : "catalog country row, not on FishBase list";
      add(`${key}${row.is_vagrant ? " (vagrant)" : ""}`);
      if (!g)
        lines.push(
          `#catalog-only\t${byId.get(id)!.name}\t${row.is_vagrant ? "vagrant" : "listed"}\t${row.evidence_source ?? ""}`,
        );
    }
    for (const [id, n] of restored) {
      add("restored species (published-2026-10-08, country tree)");
      add("restored rows (published-2026-10-08, country tree)", n);
      add(`restored species, FishBase ${matchedIds.get(id) ?? "absent"}`);
    }
    const fbNamesMatched = new Set([...matchedIds.keys()].map((id) => byId.get(id)!.name));
    add("published pack species", published.size);
    add("published pack species not on FishBase list", [...published].filter((n) => !fbNamesMatched.has(n)).length);

    writeFileSync(path.join(dir, `compare-${cCode}.tsv`), lines.join("\n") + "\n");
    writeFileSync(
      path.join(dir, `compare-${cCode}.json`),
      JSON.stringify({ country: ref.name, tally }, null, 2) + "\n",
    );
    console.log(`\n${ref.name} (${cCode})`);
    for (const k of Object.keys(tally).sort()) console.log(`  ${k}: ${tally[k]}`);
  } finally {
    client.release();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      countries: { type: "string", default: "392,170" },
      version: { type: "string", default: "v25.04" },
      compare: { type: "boolean", default: false },
    },
  });
  const version = values.version!;
  const dir = path.join(CACHE_DIR, `fishbase-${version}`);
  await download(version, dir);
  for (const cCode of values.countries!.split(",").map((c) => c.trim())) {
    const out = path.join(dir, `checklist-${cCode}.tsv`);
    if (!existsSync(out)) writeFileSync(out, rowsToTsv(await extractCountry(dir, cCode)));
    const rows = tsvToRows(readFileSync(out, "utf8"));
    console.log(`country ${cCode}: ${rows.length} species (${out})`);
    if (values.compare) await compareCountry(dir, cCode, rows);
  }
  if (values.compare) await pool.end();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
