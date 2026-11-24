// Every sea zone's marine life beyond fish and marine mammals (see build/sea-zone-marine.ts), into
// sea_zone_species. The step after compute-sea-zones-offline.ts, which owns the fish and mammal
// rows; this one owns MARINE_EXTRA_CLASSES and replaces only those.
//
//   npm run build-sea-zones-marine -w data-pipeline                 dry run: fetches, reports, rolls back
//   npm run build-sea-zones-marine -w data-pipeline -- --apply      writes
//   ... --zones="Caribbean Sea,Red Sea"   only write and report these zones (every zone still counts
//                                         for the basin check, so every zone is fetched)
//   ... --offline                         cached OBIS answers only; uncached zones are skipped
//
// OBIS answers are cached per zone and group in data/obis-checklist-cache/ (refetched only when a
// zone's outline changes), so a rerun after an interruption continues where it stopped.
// Rows that look like strays from another ocean (sea-basins.ts decideBasinStrays) are dropped and
// listed in data/review/sea-zones-marine-strays.tsv; run fix-catalog-audit after this one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@lifer/core/db.js";
import { httpFetch } from "@lifer/core/lib/http.js";
import { sanitize } from "@lifer/core/packs/packId.js";
import {
  INAT_CONFIRM_MIN_OBSERVATIONS,
  MARINE_EXTRA_CLASSES,
  OBIS_GROUPS,
  keepCandidates,
  tallyZone,
  type ObisChecklistRow,
} from "../build/sea-zone-marine.js";
import { decideBasinStrays, type ZoneSpeciesRow } from "../build/sea-basins.js";
import { FIXES_FILE, loadZoneBasins, parseFixes } from "./fix-catalog-audit.js";
import { cachedPlaceCounts } from "../regions/inatChecklist.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const CACHE_DIR = path.join(DATA_DIR, "obis-checklist-cache");
const STRAYS_TSV = path.join(DATA_DIR, "review", "sea-zones-marine-strays.tsv");
const OBIS_CHECKLIST_API = "https://api.obis.org/v3/checklist";
const PAGE_SIZE = 5000;
const log = (m: string) => console.log(`[build-sea-zones-marine] ${m}`);

interface CacheFile {
  fetchedAt: string;
  wkt: string;
  total: number;
  results: ObisChecklistRow[];
}

/** A zone's OBIS checklist for one group, from the cache or OBIS; null offline with no cache. */
async function obisChecklist(
  zone: string,
  wkt: string,
  group: string,
  offline: boolean,
): Promise<ObisChecklistRow[] | null> {
  const file = path.join(CACHE_DIR, sanitize(zone), `${group}.json`);
  if (existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, "utf8")) as CacheFile;
    if (cached.wkt === wkt) return cached.results;
  }
  if (offline) return null;
  const results: ObisChecklistRow[] = [];
  let total = 0;
  for (let skip = 0; skip === 0 || skip < total; skip += PAGE_SIZE) {
    const url = `${OBIS_CHECKLIST_API}?${new URLSearchParams({ geometry: wkt, scientificname: group, size: String(PAGE_SIZE), skip: String(skip) })}`;
    // One request at a time, a second apart: OBIS is a public service.
    const res = await httpFetch(url, { maxRetries: 5, retryServerErrors: true, paceMs: 1000, timeoutMs: 180_000 });
    if (!res.ok) throw new Error(`OBIS answered HTTP ${res.status} for ${zone} / ${group}`);
    const body = (await res.json()) as { total: number; results: ObisChecklistRow[] };
    total = body.total;
    for (const r of body.results)
      results.push({
        scientificName: r.scientificName,
        acceptedNameUsage: r.acceptedNameUsage ?? null,
        taxonRank: r.taxonRank ?? null,
        records: r.records,
        is_marine: r.is_marine ?? null,
        is_brackish: r.is_brackish ?? null,
        is_freshwater: r.is_freshwater ?? null,
        is_terrestrial: r.is_terrestrial ?? null,
      });
    if (body.results.length === 0) break;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), wkt, total, results } satisfies CacheFile));
  return results;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const offline = argv.includes("--offline");
  const only = argv
    .find((a) => a.startsWith("--zones="))
    ?.slice(8)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const client = await pool.connect();
  const { host, port, database } = client as unknown as { host: string; port: number; database: string };
  log(`database ${database} at ${host}:${port}${apply ? "" : " (dry run)"}`);
  try {
    const zonesRes = await client.query<{ id: string; name: string; wkt: string }>(
      `SELECT id, name, wkt FROM sea_zones ORDER BY name`,
    );
    const zones = zonesRes.rows;
    if (only) {
      const missing = only.filter((n) => !zones.some((z) => z.name === n));
      if (missing.length > 0) throw new Error(`No sea zone named ${missing.join(", ")}`);
    }

    const namesRes = await client.query<{ name: string; id: string }>(
      `SELECT DISTINCT ON (n.name) n.name, n.id FROM (
         SELECT scientific_name AS name, id, 0 AS pref FROM species
          WHERE NOT is_other_taxa AND taxon_class = ANY($1)
         UNION ALL
         SELECT ss.synonym_name, s.id, 1 FROM species_synonyms ss JOIN species s ON s.id = ss.species_id
          WHERE NOT s.is_other_taxa AND s.taxon_class = ANY($1)
       ) n ORDER BY n.name, n.pref`,
      [MARINE_EXTRA_CLASSES],
    );
    const speciesIdByName = new Map(namesRes.rows.map((r) => [r.name, r.id]));

    // Photographed next to the zone: iNaturalist research-grade counts of the regions linked to it,
    // from the cached place lists (no network).
    const inatRes = await client.query<{ inat_taxon_id: number; id: string }>(
      `SELECT inat_taxon_id, id FROM species WHERE inat_taxon_id IS NOT NULL AND taxon_class = ANY($1)`,
      [MARINE_EXTRA_CLASSES],
    );
    const speciesByInat = new Map(inatRes.rows.map((r) => [Number(r.inat_taxon_id), r.id]));
    const placesRes = await client.query<{ inat_place_id: number; zone_ids: string[] }>(
      `SELECT inat_place_id, array_agg(DISTINCT z) AS zone_ids
       FROM regions, unnest(nearby_sea_zone_ids) AS z
       WHERE inat_place_id IS NOT NULL GROUP BY inat_place_id`,
    );
    const confirmed = new Map<string, Set<string>>();
    for (const p of placesRes.rows) {
      const counts = cachedPlaceCounts(Number(p.inat_place_id));
      if (!counts) continue;
      for (const [taxonId, { count }] of counts) {
        const speciesId = speciesByInat.get(taxonId);
        if (!speciesId || count < INAT_CONFIRM_MIN_OBSERVATIONS) continue;
        for (const z of p.zone_ids) {
          let set = confirmed.get(z);
          if (!set) confirmed.set(z, (set = new Set()));
          set.add(speciesId);
        }
      }
    }

    // Fetched before the transaction: a first run asks OBIS for every zone, which takes a while.
    const zoneRows = new Map<string, ObisChecklistRow[]>();
    for (const [i, zone] of zones.entries()) {
      const rows: ObisChecklistRow[] = [];
      let complete = true;
      for (const group of OBIS_GROUPS) {
        const got = await obisChecklist(zone.name, zone.wkt, group, offline);
        if (!got) complete = false;
        else rows.push(...got);
      }
      if (complete) zoneRows.set(zone.id, rows);
      else log(`${zone.name}: not cached, skipped (--offline)`);
      if ((i + 1) % 25 === 0) log(`${i + 1}/${zones.length} zones read`);
    }

    await client.query("BEGIN");
    const fixes = parseFixes(JSON.parse(readFileSync(FIXES_FILE, "utf8")));
    const zb = await loadZoneBasins(client, fixes);
    const zoneIndex = new Map(zb.zones.map((z, i) => [z.id, i]));

    const candidates: ZoneSpeciesRow[] = [];
    const globalCount = new Map<string, number>();
    const marineOrBrackish = new Set<string>();
    for (const [zoneId, rows] of zoneRows) {
      const tally = tallyZone(rows, speciesIdByName, marineOrBrackish);
      for (const [id, n] of tally) globalCount.set(id, (globalCount.get(id) ?? 0) + n);
      const here = confirmed.get(zoneId);
      candidates.push(...keepCandidates(zoneIndex.get(zoneId)!, tally, (id) => here?.has(id) ?? false));
    }

    const allow = await client.query<{ id: string }>(`SELECT id FROM species WHERE scientific_name = ANY($1)`, [
      fixes.basinAllow.map((a) => a.scientificName),
    ]);
    const strays = decideBasinStrays(candidates, {
      basins: zb.basins,
      neighbours: zb.neighbours,
      bridges: zb.bridges,
      zoneNames: zb.zones.map((z) => z.name),
      globalCount,
      marineOrBrackish,
      allow: new Set(allow.rows.map((a) => a.id)),
      deep: new Set(),
    });
    const strayKeys = new Set(strays.map((s) => `${s.zone}|${s.speciesId}`));
    const kept = candidates.filter((c) => !strayKeys.has(`${c.zone}|${c.speciesId}`));

    const writeZones = zones.filter((z) => zoneRows.has(z.id) && (!only || only.includes(z.name)));
    const writeIdx = new Set(writeZones.map((z) => zoneIndex.get(z.id)!));
    const ids = writeZones.map((z) => z.id);
    const classCounts = async () =>
      new Map(
        (
          await client.query<{ taxon_class: string; n: string }>(
            `SELECT s.taxon_class, count(*) AS n FROM sea_zone_species zs JOIN species s ON s.id = zs.species_id
             WHERE zs.sea_zone_id = ANY($1) GROUP BY 1`,
            [ids],
          )
        ).rows.map((r) => [r.taxon_class, Number(r.n)]),
      );
    const before = await classCounts();
    await client.query(
      `DELETE FROM sea_zone_species zs USING species s
       WHERE s.id = zs.species_id AND zs.sea_zone_id = ANY($1) AND s.taxon_class = ANY($2)`,
      [ids, MARINE_EXTRA_CLASSES],
    );
    const rows = kept.filter((k) => writeIdx.has(k.zone));
    await client.query(
      `INSERT INTO sea_zone_species (sea_zone_id, species_id, record_count)
       SELECT unnest($1::uuid[]), unnest($2::uuid[]), unnest($3::int[])
       ON CONFLICT (sea_zone_id, species_id) DO UPDATE SET record_count = EXCLUDED.record_count`,
      [rows.map((r) => zb.zones[r.zone].id), rows.map((r) => r.speciesId), rows.map((r) => r.recordCount)],
    );
    const after = await classCounts();
    for (const cls of new Set([...before.keys(), ...after.keys()]))
      log(`  ${cls}: ${before.get(cls) ?? 0} -> ${after.get(cls) ?? 0}`);

    const names = await client.query<{ id: string; scientific_name: string; taxon_class: string }>(
      `SELECT id, scientific_name, taxon_class FROM species WHERE id = ANY($1)`,
      [[...new Set(strays.map((s) => s.speciesId))]],
    );
    const nameOf = new Map(names.rows.map((n) => [n.id, `${n.scientific_name}\t${n.taxon_class}`]));
    mkdirSync(path.dirname(STRAYS_TSV), { recursive: true });
    writeFileSync(
      STRAYS_TSV,
      [
        "zone\tscientific_name\ttaxon_class\trecords_here\trule\treason",
        ...strays
          .filter((s) => writeIdx.has(s.zone))
          .map((s) => [zb.zones[s.zone].name, nameOf.get(s.speciesId), s.recordCount, s.rule, s.reason].join("\t")),
      ].join("\n") + "\n",
    );
    log(
      `${writeZones.length} zone(s): ${rows.length} rows kept, ${strays.filter((s) => writeIdx.has(s.zone)).length} strays dropped (${path.relative(process.cwd(), STRAYS_TSV)})`,
    );
    if (apply) {
      await client.query("COMMIT");
      log("written");
    } else {
      await client.query("ROLLBACK");
      log("dry run, nothing written; rerun with --apply");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
