// Birds' exotic status from eBird. eBird's reviewers mark every observation of a non-native bird
// by where it was seen: Naturalized (an established population), Provisional (a population being
// watched that may establish) or Escapee (a cage bird or a release). Per listing, from every
// observation status seen in the province:
//   - any native observation: native, left alone;
//   - else Naturalized or Provisional: kept and marked introduced. Both count in eBird totals;
//     only Naturalized also clears the vagrant flag, as it means an established population;
//   - else Escapee only: removed, as eBird doesn't count it.
// No observation in the window: no status, left alone. A group or country goes by all its
// provinces' observations, and loses an Escapee row only once none of its provinces keeps it.
// A province eBird has no region for borrows its parent eBird region's status (its group's, else
// its country's). Natives reintroduced where eBird counts them as Naturalized
// (data/reference/reintroduced-natives.json) stay native, and so do the groups and countries
// around them.
//
// eBird offers exotic status only on observations from the last 30 days, so a province whose
// newest window is REFETCH_DAYS old gets another one in data/ebird-exotic-cache, and the statuses
// fill out over the seasons. At eBird's 500 requests an hour a full pass takes about 10 hours, so
// each run makes at most --max-requests, never-fetched provinces first. A species last seen as an Escapee is checked against all its observations in the
// window, so a county with an established population isn't outvoted.
//
// Usage (from packages/data-pipeline):
//   npx tsx src/scripts/apply-ebird-exotics.ts            (fetch what's missing or stale, preview)
//   npx tsx src/scripts/apply-ebird-exotics.ts --apply
//   ... --max-failed=20                                    (refuse when more provinces fail, default 20)
//   ... --max-requests=1000                                (eBird requests this run, default 1000)
//   ... --list                                             (print every listing removed)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@lifer/core/db.js";
import { PROVINCES_WITH_COUNTRY_SQL, provinceIdsSql } from "@lifer/core/regions/regionTree.js";
import { deleteListings, ESCAPE_MAX_RECORDS, ESTABLISHED_MIN_RECORDS, knownFeral, referenceListings } from "./remove-escapes.js";
import { cachedEbirdRegions, exoticRegionCode } from "./fix-ebird-region-codes.js";
import { requirePostgis } from "../pipeline/requirePostgis.js";
import { ebirdGet, ebirdRequests } from "../regions/ebirdApi.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CACHE_DIR = path.join(REPO_ROOT, "packages/data-pipeline/data/ebird-exotic-cache");
const REFETCH_DAYS = 90;
// How far a thin listing eBird hasn't seen may be from where the species lives wild.
export const WILD_RANGE_KM = 1000;
// Marks a native observation among eBird's N, P and X.
const NATIVE = "-";

export type ExoticStatus = "native" | "naturalized" | "provisional" | "escapee";

/** One region's statuses from one 30-day window: species seen native, and exotic ones with every
 *  category seen (N, P, X, and NATIVE when also seen native). */
export interface Snapshot {
  native: string[];
  exotic: Record<string, { sci: string; cats: string }>;
}
/** Snapshots by fetch date (YYYY-MM-DD). */
export type ExoticCache = Record<string, Snapshot>;

export function classifyExotic(cats: string): ExoticStatus | null {
  if (cats.includes(NATIVE)) return "native";
  if (cats.includes("N")) return "naturalized";
  if (cats.includes("P")) return "provisional";
  if (cats.includes("X")) return "escapee";
  return null;
}

/** Every category seen per species code across a region's snapshots, and scientific names for the
 *  exotic ones (for species whose catalog eBird code is missing or out of date). */
export function mergeSnapshots(cache: ExoticCache): { cats: Map<string, string>; sci: Map<string, string> } {
  const cats = new Map<string, string>();
  const sci = new Map<string, string>();
  const add = (code: string, c: string) => cats.set(code, [...new Set((cats.get(code) ?? "") + c)].sort().join(""));
  for (const snap of Object.values(cache)) {
    for (const code of snap.native) add(code, NATIVE);
    for (const [code, e] of Object.entries(snap.exotic)) {
      add(code, e.cats);
      sci.set(e.sci, code);
    }
  }
  return { cats, sci };
}

const categoryOf = (o: { exoticCategory?: string }) => o.exoticCategory ?? NATIVE;

type Obs = { speciesCode: string; sciName: string; exoticCategory?: string };

const readCache = (code: string): ExoticCache => {
  const file = path.join(CACHE_DIR, `${code}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
};

/** Adds today's window to a region's cache. `listed` holds the codes and names the region's
 *  checklist has, the only ones worth a second look. */
async function refreshRegion(code: string, listed: Set<string>, key: string): Promise<void> {
  const cache = readCache(code);
  const base = `data/obs/${code}/recent`;
  const obs = (await ebirdGet<Obs>(`${base}?back=30&includeProvisional=true`, key)) ?? [];
  const snap: Snapshot = { native: [], exotic: {} };
  for (const o of obs) {
    if (!o.exoticCategory) snap.native.push(o.speciesCode);
    else snap.exotic[o.speciesCode] = { sci: o.sciName, cats: o.exoticCategory };
  }
  // The region list gives only each species' latest observation, from wherever it was.
  for (const [sp, e] of Object.entries(snap.exotic)) {
    if (e.cats !== "X" || !(listed.has(sp) || listed.has(e.sci))) continue;
    const all = (await ebirdGet<Obs>(`${base}/${sp}?back=30&includeProvisional=true`, key)) ?? [];
    e.cats = [...new Set(["X", ...all.map(categoryOf)])].sort().join("");
  }
  cache[new Date().toISOString().slice(0, 10)] = snap;
  writeFileSync(path.join(CACHE_DIR, `${code}.json`), JSON.stringify(cache));
}

function cachedRegion(code: string): ReturnType<typeof mergeSnapshots> | null {
  const cache = readCache(code);
  return Object.keys(cache).length > 0 ? mergeSnapshots(cache) : null;
}

interface Listing {
  region_id: string;
  species_id: string;
  ebird_code: string | null;
  scientific_name: string;
  n: number;
}

/** Species codes eBird has seen as an Escapee anywhere, and for each code the regions where it's
 *  seen native, Naturalized or Provisional. */
export function wildRanges(regionCats: Map<string, { cats: Map<string, string> }>) {
  const escapeeSomewhere = new Set<string>();
  const wildAt = new Map<string, string[]>();
  for (const [region, m] of regionCats)
    for (const [code, c] of m.cats) {
      if (c.includes("X")) escapeeSomewhere.add(code);
      if (/[-NP]/.test(c)) wildAt.set(code, [...(wildAt.get(code) ?? []), region]);
    }
  return { escapeeSomewhere, wildAt };
}

/** Moves reintroduced natives ("region_id|species_id") out of Naturalized and Provisional. */
export function withReintroduced<T extends { region_id: string; species_id: string }>(
  by: Record<ExoticStatus, T[]>,
  natives: Set<string>,
): Record<ExoticStatus, T[]> {
  const isNative = (l: T) => natives.has(`${l.region_id}|${l.species_id}`);
  return {
    native: [...by.native, ...by.naturalized.filter(isNative), ...by.provisional.filter(isNative)],
    naturalized: by.naturalized.filter((l) => !isNative(l)),
    provisional: by.provisional.filter((l) => !isNative(l)),
    escapee: by.escapee,
  };
}

export async function applyEbirdExotics(opts: {
  apply: boolean;
  maxFailed?: number;
  maxRequests?: number;
  list?: boolean;
  log?: (m: string) => void;
}) {
  const log = opts.log ?? ((m) => console.log(`[ebird-exotics] ${m}`));
  // Each province with its country and, when grouped, its group.
  const provinces = (
    await pool.query<{ id: string; own: string; country_id: string; group_id: string | null; group_name: string | null }>(
      `SELECT p.id, r.ebird_region_code AS own, p.country_id, g.id AS group_id, g.name AS group_name
       FROM (${PROVINCES_WITH_COUNTRY_SQL}) p JOIN regions r ON r.id = p.id
       LEFT JOIN regions g ON g.id = r.parent_id AND g.id <> p.country_id
       WHERE r.ebird_region_code IS NOT NULL`,
    )
  )
    .rows.map((p) => ({ ...p, code: exoticRegionCode(p.own, p.group_name, cachedEbirdRegions(p.own.slice(0, 2))) }))
    .filter((p): p is typeof p & { code: string } => p.code !== null);
  const birdRows = `SELECT rs.region_id, rs.species_id, s.ebird_code, s.scientific_name,
                           greatest(COALESCE(rs.local_frequency, 0), COALESCE(rs.inat_rg_count, 0))::int AS n
                    FROM region_species rs JOIN species s ON s.id = rs.species_id
                    WHERE s.taxon_class = 'aves' AND NOT s.is_other_taxa`;
  const listings = (await pool.query<Listing>(birdRows)).rows;
  const listedIn = new Map<string, Set<string>>();
  for (const l of listings) {
    const set = listedIn.get(l.region_id) ?? new Set();
    if (l.ebird_code) set.add(l.ebird_code);
    set.add(l.scientific_name);
    listedIn.set(l.region_id, set);
  }

  const key = process.env.EBIRD_API_KEY?.trim();
  if (!key) log("WARNING: EBIRD_API_KEY is not set; only cached eBird statuses are used");
  else {
    mkdirSync(CACHE_DIR, { recursive: true });
    let failed = 0;
    // Never fetched first, then the oldest windows. Placeholder codes (with "~") aren't eBird's.
    // Provinces borrowing one parent region share its window and their lists.
    const listedAt = new Map<string, Set<string>>();
    for (const p of provinces)
      for (const k of listedIn.get(p.id) ?? []) listedAt.set(p.code, (listedAt.get(p.code) ?? new Set()).add(k));
    const due = [...listedAt.keys()]
      .filter((code) => !code.includes("~"))
      .map((code) => ({ code, newest: Object.keys(readCache(code)).sort().at(-1) ?? "" }))
      .filter((p) => !p.newest || Date.now() - Date.parse(p.newest) >= REFETCH_DAYS * 86_400_000)
      .sort((a, b) => a.newest.localeCompare(b.newest));
    const maxRequests = opts.maxRequests ?? 1000;
    let done = 0;
    for (const p of due) {
      if (ebirdRequests() >= maxRequests) break;
      try {
        await refreshRegion(p.code, listedAt.get(p.code)!, key);
      } catch (err) {
        failed++;
        log(`${p.code}: ${(err as Error).message}`);
      }
      if (++done % 100 === 0) log(`${done}/${due.length} provinces fetched (${failed} failed)`);
    }
    if (done < due.length) log(`${due.length - done} provinces left for the next run (--max-requests=${maxRequests})`);
    // Past a few, the lists would depend on how this run's fetches went.
    if (failed > (opts.maxFailed ?? 20)) throw new Error(`${failed} provinces failed; nothing was changed, rerun to retry`);
  }

  // Categories per (region, species code), pooled up to groups and countries.
  const regionCats = new Map<string, ReturnType<typeof mergeSnapshots>>();
  const pooled = new Map<string, ReturnType<typeof mergeSnapshots>>();
  for (const p of provinces) {
    const merged = cachedRegion(p.code);
    if (!merged) continue;
    regionCats.set(p.id, merged);
    for (const up of [p.country_id, p.group_id]) {
      if (!up) continue;
      const into = pooled.get(up) ?? { cats: new Map(), sci: new Map() };
      for (const [c, v] of merged.cats) into.cats.set(c, [...new Set((into.cats.get(c) ?? "") + v)].sort().join(""));
      for (const [s, c] of merged.sci) into.sci.set(s, c);
      pooled.set(up, into);
    }
  }
  const statusOf = (l: Listing): ExoticStatus | null => {
    const m = regionCats.get(l.region_id) ?? pooled.get(l.region_id);
    if (!m) return null;
    const code = (l.ebird_code && m.cats.has(l.ebird_code) ? l.ebird_code : null) ?? m.sci.get(l.scientific_name);
    return code ? classifyExotic(m.cats.get(code)!) : null;
  };
  let by: Record<ExoticStatus, Listing[]> = { native: [], naturalized: [], provisional: [], escapee: [] };
  const unseen: Listing[] = [];
  for (const l of listings) {
    const s = statusOf(l);
    if (s) by[s].push(l);
    else unseen.push(l);
  }
  const reintroduced = await referenceListings(pool, "reintroduced-natives.json");
  for (const p of provinces)
    for (const k of [...reintroduced].filter((k) => k.startsWith(`${p.id}|`))) {
      const sid = k.split("|")[1];
      reintroduced.add(`${p.country_id}|${sid}`);
      if (p.group_id) reintroduced.add(`${p.group_id}|${sid}`);
    }
  by = withReintroduced(by, reintroduced);
  // A thin listing eBird hasn't seen in its windows, of a cage bird eBird has seen escaped
  // elsewhere, is judged by distance: an old one-off flamingo or macaw never shows in 30 days.
  const { escapeeSomewhere, wildAt } = wildRanges(regionCats);
  const allSci = new Map<string, string>();
  for (const m of regionCats.values()) for (const [sci, code] of m.sci) allSci.set(sci, code);
  const codeOf = (l: Listing) => (l.ebird_code && escapeeSomewhere.has(l.ebird_code) ? l.ebird_code : allSci.get(l.scientific_name));
  const doubtful = unseen.filter((l) => l.n < ESCAPE_MAX_RECORDS && escapeeSomewhere.has(codeOf(l) ?? ""));
  const doubtfulSpecies = new Map(doubtful.map((l) => [l.species_id, codeOf(l)!]));
  const provinceIdSet = new Set(provinces.map((p) => p.id));
  const escapeeIds = new Set(by.escapee.map((l) => `${l.region_id}|${l.species_id}`));
  // Where each doubtful species lives wild: eBird sees it native, Naturalized or Provisional
  // there, or a province list has it well recorded. Where it's native (by iNaturalist), more
  // records than an escape leaves will do: a vagrant's wintering grounds may have no sighting in
  // the windows yet.
  const introducedIn = new Set(
    (
      await pool.query<{ k: string }>(
        `SELECT p.id || '|' || snc.species_id AS k FROM (${PROVINCES_WITH_COUNTRY_SQL}) p JOIN regions c ON c.id = p.country_id
         JOIN species_nonnative_countries snc ON snc.country_iso3 = ANY(c.external_codes) AND snc.species_id = ANY($1)`,
        [[...doubtfulSpecies.keys()]],
      )
    ).rows.map((r) => r.k),
  );
  const anchors: Array<[string, string]> = [];
  for (const [sid, code] of doubtfulSpecies) for (const r of wildAt.get(code) ?? []) anchors.push([r, sid]);
  for (const l of listings) {
    const k = `${l.region_id}|${l.species_id}`;
    const enough = introducedIn.has(k) ? ESTABLISHED_MIN_RECORDS : ESCAPE_MAX_RECORDS;
    if (doubtfulSpecies.has(l.species_id) && provinceIdSet.has(l.region_id) && l.n >= enough && !escapeeIds.has(k))
      anchors.push([l.region_id, l.species_id]);
  }
  log(
    `statuses for ${listings.length} bird listings: ${by.native.length} native, ${by.naturalized.length} naturalized, ` +
      `${by.provisional.length} provisional, ${by.escapee.length} escapee only`,
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = (rows: Listing[]) => [rows.map((r) => r.region_id), rows.map((r) => r.species_id)];
    await client.query(
      `CREATE TEMP TABLE esc_x ON COMMIT DROP AS
       SELECT v.* FROM unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
       WHERE NOT EXISTS (SELECT 1 FROM region_species_manual_overrides m WHERE m.region_id = v.region_id AND m.species_id = v.species_id)`,
      ids(by.escapee),
    );
    await requirePostgis(client, "apply-ebird-exotics.ts");
    await client.query(
      `CREATE TEMP TABLE ex_prov ON COMMIT DROP AS
       SELECT p.id, p.country_id, NULLIF(r.parent_id, p.country_id) AS group_id,
              ST_Simplify(ST_Force2D(ST_GeomFromGeoJSON((r.boundary_geojson->'geometry')::text)), 0.05, true)::geography AS g
       FROM (${PROVINCES_WITH_COUNTRY_SQL}) p JOIN regions r ON r.id = p.id WHERE r.boundary_geojson ? 'geometry'`,
    );
    await client.query(`CREATE INDEX ON ex_prov USING gist (g); CREATE INDEX ON ex_prov (id)`);
    await client.query(
      `CREATE TEMP TABLE ex_anchor ON COMMIT DROP AS SELECT * FROM unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)`,
      [anchors.map((a) => a[0]), anchors.map((a) => a[1])],
    );
    await client.query(`CREATE INDEX ON ex_anchor (species_id, region_id); ANALYZE ex_prov; ANALYZE ex_anchor`);
    const inferred = (
      await client.query<{ region_id: string; species_id: string }>(
        `INSERT INTO esc_x SELECT v.* FROM unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
         WHERE NOT EXISTS (SELECT 1 FROM region_species_manual_overrides m WHERE m.region_id = v.region_id AND m.species_id = v.species_id)
           AND NOT EXISTS (SELECT 1 FROM ex_prov pc JOIN ex_anchor a ON a.species_id = v.species_id JOIN ex_prov pa ON pa.id = a.region_id
                           WHERE (pc.id = v.region_id OR pc.country_id = v.region_id OR pc.group_id = v.region_id)
                             AND ST_DWithin(pc.g, pa.g, $3 * 1000))
         RETURNING *`,
        [...ids(doubtful), WILD_RANGE_KM],
      )
    ).rows;
    const keep = [...(await knownFeral(client))].map((k) => k.split("|"));
    await client.query(
      `DELETE FROM esc_x x USING unnest($1::uuid[], $2::uuid[]) AS k(region_id, species_id)
       WHERE x.region_id = k.region_id AND x.species_id = k.species_id`,
      [keep.map((k) => k[0]), keep.map((k) => k[1])],
    );
    const provinceIds = new Set(provinces.map((p) => p.id));
    const name = async (rows: Array<{ region_id: string; species_id: string }>) =>
      (
        await client.query<{ s: string }>(
          `SELECT s.common_name || ' in ' || r.name AS s FROM unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
           JOIN species s ON s.id = v.species_id JOIN regions r ON r.id = v.region_id ORDER BY md5(s.id::text || r.id::text) LIMIT 15`,
          [rows.map((r) => r.region_id), rows.map((r) => r.species_id)],
        )
      ).rows
        .map((r) => r.s)
        .join("; ");
    // Provinces first, so a group or country can tell whether any province still keeps the bird.
    const gone = (
      await client.query<{ region_id: string; species_id: string }>(`SELECT * FROM esc_x WHERE region_id = ANY($1)`, [
        [...provinceIds],
      ])
    ).rows;
    await deleteListings(client, gone);
    const above = (
      await client.query<{ region_id: string; species_id: string }>(
        `SELECT x.* FROM esc_x x WHERE NOT (x.region_id = ANY($1))
           AND NOT EXISTS (SELECT 1 FROM region_species ps WHERE ps.species_id = x.species_id
                           AND ps.region_id IN (${provinceIdsSql("x.region_id")}))`,
        [[...provinceIds]],
      )
    ).rows;
    await deleteListings(client, above);
    const naturalized = await client.query(
      `UPDATE region_species rs SET is_invasive = true, is_vagrant = false FROM unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
       WHERE rs.region_id = v.region_id AND rs.species_id = v.species_id AND (rs.is_vagrant OR NOT COALESCE(rs.is_invasive, false))`,
      ids(by.naturalized),
    );
    const provisional = await client.query(
      `UPDATE region_species rs SET is_invasive = true FROM unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
       WHERE rs.region_id = v.region_id AND rs.species_id = v.species_id AND NOT COALESCE(rs.is_invasive, false)`,
      ids(by.provisional),
    );
    log(`e.g. escapees removed: ${await name([...gone, ...above])}`);
    if (opts.list) {
      const all = await client.query<{ s: string }>(
        `SELECT r.name || '	' || s.common_name || '	' || CASE WHEN i.region_id IS NULL THEN 'escapee' ELSE 'far from wild range' END AS s
         FROM unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id) JOIN species s ON s.id = v.species_id JOIN regions r ON r.id = v.region_id
         LEFT JOIN unnest($3::uuid[], $4::uuid[]) AS i(region_id, species_id) ON i.region_id = v.region_id AND i.species_id = v.species_id
         ORDER BY 1`,
        [[...gone, ...above].map((x) => x.region_id), [...gone, ...above].map((x) => x.species_id), inferred.map((x) => x.region_id), inferred.map((x) => x.species_id)],
      );
      for (const row of all.rows) console.log(row.s);
    }
    log(`of which ${inferred.length} unseen by eBird, far from where it lives wild, e.g. ${await name(inferred)}`);
    log(`e.g. naturalized: ${await name(by.naturalized)}`);
    log(`e.g. provisional: ${await name(by.provisional)}`);
    log(
      `removed ${gone.length} province and ${above.length} group/country escapee listings; marked introduced: ` +
        `${naturalized.rowCount} naturalized, ${provisional.rowCount} provisional`,
    );
    await client.query(opts.apply ? "COMMIT" : "ROLLBACK");
    log(opts.apply ? "applied" : "preview only (pass --apply)");
    return { removed: gone.length + above.length, naturalized: naturalized.rowCount, provisional: provisional.rowCount };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const maxFailed = process.argv.find((a) => a.startsWith("--max-failed="))?.slice("--max-failed=".length);
  const maxRequests = process.argv.find((a) => a.startsWith("--max-requests="))?.slice("--max-requests=".length);
  applyEbirdExotics({
    apply: process.argv.includes("--apply"),
    maxFailed: maxFailed ? Number(maxFailed) : undefined,
    maxRequests: maxRequests ? Number(maxRequests) : undefined,
    list: process.argv.includes("--list"),
  })
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
