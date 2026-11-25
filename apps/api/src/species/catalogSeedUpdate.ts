// Merges a published catalog seed (a gzipped pg_dump of the catalog tables) into an existing
// install: the Settings catalog update and every new install's first-boot load (desktop and server).
//
// Each COPY block is streamed unparsed into an all-text temp table (so a slightly different
// schema still loads), then merged into the real table in FK-safe order without overwriting
// local file-path columns. Everything, including the recorded version, runs in one transaction.
// Uses only the pg driver because no psql binary can be assumed.
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Pool, PoolClient } from "pg";
import { APP_DATA_DIR, BUNDLED_CATALOG_SEED_DIR } from "@lifer/core/config.js";
import { createJob, describeError, JobCancelledError, type JobContext } from "../lib/job.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";
import { copyInto, readLines } from "../lib/pgCopy.js";
import { downloadResumable, sha256OfFile } from "@lifer/core/lib/resumableDownload.js";
import { catalogSeedAsset, fetchCatalogManifest, type CatalogManifest } from "./catalogManifest.js";
import { invalidateSuggestionCache, isModelDownloaded } from "@lifer/core/species/embeddings.js";
import { runGalleryEmbeddingsUpdate, type ReferenceVectorsResult } from "./galleryEmbeddingsAsset.js";
import { lockReferenceData } from "@lifer/core/lib/referenceDataLock.js";
import { applySpeciesMerges } from "@lifer/core/species/speciesMerges.js";
import { resolveSpeciesSplits } from "./speciesSplits.js";
import { syncCaptureXmpSidecarsLogged } from "../uploads/xmpSidecarSync.js";
import { log } from "@lifer/core/lib/log.js";
import { normalizeIucnStatus, type LoadProgress } from "@lifer/shared";
import { upgradeRegionLocalities } from "../places/gazetteer.js";
import { ensureSpeciesSearchNames } from "./search.js";
import { ensureRegionRollup } from "../regions/rollup.js";

export { fetchCatalogManifest, type CatalogManifest };

export const CATALOG_DOWNLOAD_DIR = path.join(APP_DATA_DIR, "catalog-downloads");
const CATALOG_SEED_VERSION_KEY = "catalog_seed_version";

export async function getAppliedCatalogVersion(db: Pool | PoolClient): Promise<number | null> {
  const v = await getInstallSetting<number>(db, CATALOG_SEED_VERSION_KEY);
  return v == null ? null : Number(v);
}

// The catalog version is per install, not per user.
export async function checkCatalogUpdate(
  pool: Pool,
): Promise<{ available: boolean; remoteVersion: number; localVersion: number | null; downloadBytes: number | null }> {
  const manifest = await fetchCatalogManifest();
  const localVersion = await getAppliedCatalogVersion(pool);
  return {
    available: localVersion == null || manifest.version > localVersion,
    remoteVersion: manifest.version,
    localVersion,
    downloadBytes: manifest.seed?.bytes ?? null,
  };
}

// FK-safe order: species first, regions before region_species, etc. Tables in the seed that
// aren't listed here are skipped.
const MERGE_TABLES: Array<{ table: string; pkColumns: string[]; excludeFromUpdate: string[] }> = [
  // photo_checked_at: when this install last tried to fetch a withheld photo (species/withheldPhotos.ts).
  {
    table: "species",
    pkColumns: ["id"],
    excludeFromUpdate: ["reference_display_path", "reference_thumb_path", "photo_checked_at"],
  },
  // Duplicate species folded into one; applied by applySpeciesMerges after every table is in.
  { table: "species_merges", pkColumns: ["old_species_id"], excludeFromUpdate: [] },
  // Species split into several; photos filed under one are re-filed by place after commit.
  { table: "species_splits", pkColumns: ["parent_species_id", "daughter_species_id"], excludeFromUpdate: [] },
  { table: "species_traits", pkColumns: ["species_id"], excludeFromUpdate: [] },
  { table: "species_rarity", pkColumns: ["species_id"], excludeFromUpdate: [] },
  // Keyed by the name (unique), so a synonym an install already has keeps its own id.
  { table: "species_synonyms", pkColumns: ["synonym_name"], excludeFromUpdate: ["id"] },
  { table: "regions", pkColumns: ["id"], excludeFromUpdate: [] },
  // The seed has no tier explanations, so an update keeps the ones an installed pack wrote.
  { table: "region_species", pkColumns: ["region_id", "species_id"], excludeFromUpdate: ["tier_explain"] },
  { table: "sea_zones", pkColumns: ["id"], excludeFromUpdate: [] },
  { table: "sea_zone_species", pkColumns: ["sea_zone_id", "species_id"], excludeFromUpdate: [] },
  { table: "species_reference_embeddings", pkColumns: ["species_id"], excludeFromUpdate: [] },
  { table: "species_text_embeddings", pkColumns: ["species_id"], excludeFromUpdate: [] },
  { table: "reference_photo_blocklist", pkColumns: ["photo_url"], excludeFromUpdate: [] },
  // After regions, whose id remap it takes. The seed carries the whole town list.
  { table: "gazetteer_places", pkColumns: ["geoname_id"], excludeFromUpdate: [] },
];
const PHOTOS_TABLE = "species_reference_photos";
// Only present in seeds published before the gallery embeddings moved to their own asset.
const LEGACY_GALLERY_TABLE = "species_reference_gallery_embeddings";
const LOADED_TABLES = new Set([...MERGE_TABLES.map((t) => t.table), PHOTOS_TABLE, LEGACY_GALLERY_TABLE]);

// Self-referencing parent pointers are inserted NULL first and set in a second pass, so a child
// row never lands before the parent it points at.
const SELF_REFERENCING_PARENT_COLUMN: Record<string, string> = { regions: "parent_id" };

// A species the seed ships without its photo for licensing reasons (photo_withheld) keeps the one
// this install fetched for itself (species/withheldPhotos.ts, or opening the species online).
// Otherwise the seed's empty photo would wipe it, and the install would fetch it all over again.
const LOCAL_WITHHELD_PHOTO_COLUMNS = new Set([
  "reference_photo",
  "reference_credit",
  "reference_license",
  "reference_focal_x",
  "reference_focal_y",
]);

const tmpName = (table: string) => `tmp_seed_${table}`;
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const unquote = (name: string) => (name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name);

const COPY_HEADER = /^COPY (?:public\.)?("(?:[^"]|"")+"|\w+) \((.*)\) FROM stdin;$/;

export interface CatalogMergeResult {
  merged: Record<string, number>;
  referenceVectors?: ReferenceVectorsResult | null;
}

type Progress = Pick<JobContext<CatalogMergeResult>, "update" | "throwIfCancelled">;

/** Streams the gzipped dump into one temp table per catalog table. Returns the column list
 * (unquoted) each table's COPY block carried; `spans` gets each table's share of the file's bytes. */
async function loadSeedIntoTempTables(
  client: PoolClient,
  seedPath: string,
  progress: Progress,
  onlyTables?: Set<string>,
  spans?: Map<string, number>,
): Promise<Map<string, string[]>> {
  const loaded = new Map<string, string[]>();
  const wanted = (table: string) => LOADED_TABLES.has(table) && (!onlyTables || onlyTables.has(table));
  const totalBytes = statSync(seedPath).size;
  let readBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      readBytes += chunk.length;
      cb(null, chunk);
    },
  });
  const gunzip = createGunzip();
  // pipeline() (not .pipe()) so a read error reaches the gunzip stream this loop iterates.
  pipeline(createReadStream(seedPath), counter, gunzip).catch((err) => gunzip.destroy(err));
  const iterator = readLines(gunzip)[Symbol.asyncIterator]();

  // Yields one COPY block's body lines (each with its "\n" restored) and stops at "\.".
  async function* blockBody(): AsyncGenerator<Buffer> {
    let n = 0;
    while (true) {
      const { value, done } = await iterator.next();
      if (done) throw new Error("Catalog seed ends in the middle of a table (truncated file?)");
      if (value.length === 2 && value[0] === 0x5c && value[1] === 0x2e) return; // "\."
      if (++n % 5000 === 0) {
        progress.throwIfCancelled();
        progress.update({ downloadedBytes: readBytes, totalBytes });
      }
      yield Buffer.concat([value, Buffer.from("\n")]);
    }
  }

  try {
    while (true) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (value.length < 5 || value[0] !== 0x43 /* C */) continue;
      const match = COPY_HEADER.exec(value.toString("utf8"));
      if (!match) continue;
      const table = unquote(match[1]);
      const columns = match[2].split(",").map((c) => unquote(c.trim()));

      if (!wanted(table)) {
        for await (const _ of blockBody()) void _; // skip
        continue;
      }
      progress.throwIfCancelled();
      progress.update({ currentItem: table, downloadedBytes: readBytes, totalBytes });
      const start = readBytes;
      await client.query(
        `CREATE TEMP TABLE ${ident(tmpName(table))} (${columns.map((c) => `${ident(c)} text`).join(", ")}) ON COMMIT DROP`,
      );
      await copyInto(
        client,
        `COPY ${ident(tmpName(table))} (${columns.map(ident).join(", ")}) FROM STDIN`,
        blockBody(),
      );
      loaded.set(table, columns);
      spans?.set(table, readBytes - start);
      // A partial load can stop reading as soon as it has everything it asked for.
      if (onlyTables && [...onlyTables].every((t) => loaded.has(t))) break;
    }
  } finally {
    gunzip.destroy();
  }
  progress.update({ downloadedBytes: totalBytes, totalBytes });
  return loaded;
}

async function columnTypes(client: PoolClient, table: string): Promise<Map<string, string>> {
  const res = await client.query<{ attname: string; type: string }>(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
    [`public.${table}`],
  );
  return new Map(res.rows.map((r) => [r.attname, r.type]));
}

// Seed columns this install's schema also has. Extra seed columns (seed built from a newer
// schema) are dropped with a warning instead of failing the whole update.
async function sharedColumns(
  client: PoolClient,
  table: string,
  seedColumns: string[],
): Promise<Array<{ name: string; type: string }>> {
  const types = await columnTypes(client, table);
  const unknown = seedColumns.filter((c) => !types.has(c));
  if (unknown.length > 0)
    log.warn(`[catalog-update] ${table}: ignoring columns not in this schema: ${unknown.join(", ")}`);
  return seedColumns.filter((c) => types.has(c)).map((c) => ({ name: c, type: types.get(c)! }));
}

async function mergeGenericTable(
  client: PoolClient,
  spec: (typeof MERGE_TABLES)[number],
  seedColumns: string[],
  loadedTables: Set<string>,
): Promise<number> {
  const { table, pkColumns, excludeFromUpdate } = spec;
  if (table in SELF_REFERENCING_PARENT_COLUMN) {
    return mergeSelfReferencingTable(client, table, SELF_REFERENCING_PARENT_COLUMN[table], seedColumns, loadedTables);
  }

  const cols = await sharedColumns(client, table, seedColumns);
  // A synonym the seed renamed in place keeps its id: the local row under the old name goes, or
  // the insert would collide on the id and roll the whole update back.
  if (table === "species_synonyms" && cols.some((c) => c.name === "id")) {
    await client.query(
      `DELETE FROM species_synonyms s USING ${ident(tmpName(table))} t WHERE s.id = t.id::uuid AND s.synonym_name <> t.synonym_name::text`,
    );
  }
  const select = cols.map((c) => `${ident(c.name)}::${c.type}`);
  const updatable = cols.filter((c) => !pkColumns.includes(c.name) && !excludeFromUpdate.includes(c.name));
  const keepLocalWithheldPhoto =
    table === "species" &&
    cols.some((c) => c.name === "photo_withheld") &&
    cols.some((c) => c.name === "reference_photo");
  const value = (column: string) =>
    keepLocalWithheldPhoto && LOCAL_WITHHELD_PHOTO_COLUMNS.has(column)
      ? `CASE WHEN EXCLUDED.photo_withheld AND EXCLUDED.reference_photo IS NULL ` +
        `THEN ${ident(table)}.${ident(column)} ELSE EXCLUDED.${ident(column)} END`
      : `EXCLUDED.${ident(column)}`;
  // Only rows that differ are written: most of a release's rows are unchanged, and rewriting them
  // (with their indexes) was most of an update's time.
  const onConflict =
    updatable.length > 0
      ? `DO UPDATE SET ${updatable.map((c) => `${ident(c.name)} = ${value(c.name)}`).join(", ")}
         WHERE (${updatable.map((c) => `${ident(table)}.${ident(c.name)}`).join(", ")})
           IS DISTINCT FROM (${updatable.map((c) => value(c.name)).join(", ")})`
      : "DO NOTHING";
  const res = await client.query(
    `INSERT INTO ${ident(table)} (${cols.map((c) => ident(c.name)).join(", ")})
     SELECT ${select.join(", ")} FROM ${ident(tmpName(table))}
     ON CONFLICT (${pkColumns.map(ident).join(", ")}) ${onConflict}`,
  );
  return res.rowCount ?? 0;
}

// The seed carries each region's and sea zone's whole checklist, so local rows it no longer lists
// are removed. Only groups the seed has rows for are touched. The user's own additions, hand
// imports included, live in separate tables (regions/checklistAdditions.ts) and are never pruned.
// Runs after the region id remap, so ids are local.
const CHECKLIST_GROUP_COLUMN: Record<string, string> = { region_species: "region_id", sea_zone_species: "sea_zone_id" };

async function pruneChecklistsFromSeed(client: PoolClient, table: string, groupColumn: string): Promise<number> {
  const tmp = ident(tmpName(table));
  const col = ident(groupColumn);
  // Temp tables are never auto-analyzed; without stats the anti-join over millions of seed rows
  // can be planned as a nested loop.
  await client.query(`ANALYZE ${tmp}`);
  const res = await client.query<{ group_id: string; species_id: string }>(
    `DELETE FROM ${ident(table)} t
     WHERE t.${col} IN (SELECT DISTINCT ${col}::uuid FROM ${tmp})
       AND NOT EXISTS (SELECT 1 FROM ${tmp} s WHERE s.${col}::uuid = t.${col} AND s.species_id::uuid = t.species_id)
     RETURNING t.${col} AS group_id, t.species_id`,
  );
  if (table === "region_species" && res.rows.length > 0) {
    await client.query(
      `DELETE FROM region_species_hotspots h
       USING unnest($1::uuid[], $2::uuid[]) AS gone(region_id, species_id)
       WHERE h.region_id = gone.region_id AND h.species_id = gone.species_id`,
      [res.rows.map((r) => r.group_id), res.rows.map((r) => r.species_id)],
    );
  }
  return res.rows.length;
}

// region_species is the catalog's largest table (millions of rows), and most of a release's rows
// are unchanged. An upsert visits and locks every row, which was most of an update's time, so it's
// diffed instead, as three set-based statements on the seed's rows typed once: update the rows
// whose values changed, insert the new ones, and delete the ones the seed no longer lists for a
// region it covers. Columns the seed doesn't update (an installed pack's tier explanations) are
// left alone, regions the seed doesn't cover keep their rows, and readers aren't blocked.
async function diffChecklistFromSeed(
  client: PoolClient,
  spec: (typeof MERGE_TABLES)[number],
  seedColumns: string[],
): Promise<{ written: number; removed: number }> {
  const { table, pkColumns, excludeFromUpdate } = spec;
  const t = ident(table);
  const group = ident(CHECKLIST_GROUP_COLUMN[table]);
  const shared = await sharedColumns(client, table, seedColumns);
  const keyMatch = pkColumns.map((k) => `s.${ident(k)} = t.${ident(k)}`).join(" AND ");
  const updatable = shared.filter((c) => !pkColumns.includes(c.name) && !excludeFromUpdate.includes(c.name));

  await client.query(
    `CREATE TEMP TABLE checklist_next ON COMMIT DROP AS
     SELECT ${shared.map((c) => `${ident(c.name)}::${c.type} AS ${ident(c.name)}`).join(", ")}
       FROM ${ident(tmpName(table))}`,
  );
  await client.query(`ANALYZE checklist_next`);

  let written = 0;
  if (updatable.length > 0) {
    const changed = await client.query(
      `UPDATE ${t} t SET ${updatable.map((c) => `${ident(c.name)} = s.${ident(c.name)}`).join(", ")}
         FROM checklist_next s
        WHERE ${keyMatch}
          AND (${updatable.map((c) => `t.${ident(c.name)}`).join(", ")})
              IS DISTINCT FROM (${updatable.map((c) => `s.${ident(c.name)}`).join(", ")})`,
    );
    written += changed.rowCount ?? 0;
  }
  // The key decides what's new: an anti-join here can be planned as a scan per row on an empty or
  // just-emptied table. DO NOTHING takes no row locks, unlike the upsert this replaces.
  const added = await client.query(
    `INSERT INTO ${t} (${shared.map((c) => ident(c.name)).join(", ")})
     SELECT ${shared.map((c) => `s.${ident(c.name)}`).join(", ")} FROM checklist_next s
     ON CONFLICT (${pkColumns.map(ident).join(", ")}) DO NOTHING`,
  );
  written += added.rowCount ?? 0;
  const removed = await client.query<{ group_id: string; species_id: string }>(
    `DELETE FROM ${t} t
      WHERE t.${group} IN (SELECT DISTINCT ${group} FROM checklist_next)
        AND NOT EXISTS (SELECT 1 FROM checklist_next s WHERE ${keyMatch})
     RETURNING t.${group} AS group_id, t.species_id`,
  );
  if (table === "region_species" && removed.rows.length > 0) {
    await client.query(
      `DELETE FROM region_species_hotspots h
       USING unnest($1::uuid[], $2::uuid[]) AS gone(region_id, species_id)
       WHERE h.region_id = gone.region_id AND h.species_id = gone.species_id`,
      [removed.rows.map((r) => r.group_id), removed.rows.map((r) => r.species_id)],
    );
  }
  return { written, removed: removed.rows.length };
}

// SET LOCAL that falls back silently: replication role needs superuser, lz4 needs a server built with it.
async function trySetLocal(client: PoolClient, setting: string, value: string): Promise<boolean> {
  await client.query("SAVEPOINT try_set_local");
  try {
    await client.query(`SET LOCAL ${setting} = ${value}`);
    await client.query("RELEASE SAVEPOINT try_set_local");
    return true;
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT try_set_local");
    return false;
  }
}

async function isEmptyTable(client: PoolClient, table: string): Promise<boolean> {
  const res = await client.query(`SELECT 1 FROM ${ident(table)} LIMIT 1`);
  return res.rowCount === 0;
}

// An empty table (a fresh install) has nothing to merge with, so the seed's rows go straight in:
// FK checks and row triggers off (the seed is checksum-verified; search names are rebuilt after
// commit) and indexes built once afterwards instead of row by row. Keys a foreign key points at
// have to stay.
async function insertIntoEmptyTable(client: PoolClient, table: string, seedColumns: string[]): Promise<number> {
  const cols = await sharedColumns(client, table, seedColumns);
  const t = ident(table);
  const keys = await client.query<{ name: string; def: string }>(
    `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.conrelid = $1::regclass AND c.contype IN ('p', 'u')
        AND NOT EXISTS (SELECT 1 FROM pg_constraint f WHERE f.contype = 'f' AND f.conindid = c.conindid)`,
    [`public.${table}`],
  );
  const indexes = await client.query<{ name: string; def: string }>(
    `SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = $1::regclass AND NOT i.indisunique AND NOT i.indisexclusion`,
    [`public.${table}`],
  );
  for (const k of keys.rows) await client.query(`ALTER TABLE ${t} DROP CONSTRAINT ${ident(k.name)}`);
  for (const ix of indexes.rows) await client.query(`DROP INDEX ${ident(ix.name)}`);
  const replica = await trySetLocal(client, "session_replication_role", "replica");
  const res = await client.query(
    `INSERT INTO ${t} (${cols.map((c) => ident(c.name)).join(", ")})
     SELECT ${cols.map((c) => `${ident(c.name)}::${c.type}`).join(", ")} FROM ${ident(tmpName(table))}`,
  );
  if (replica) await client.query("SET LOCAL session_replication_role = origin");
  for (const k of keys.rows) await client.query(`ALTER TABLE ${t} ADD CONSTRAINT ${ident(k.name)} ${k.def}`);
  for (const ix of indexes.rows) await client.query(ix.def);
  await client.query(`ANALYZE ${ident(table)}`);
  return res.rowCount ?? 0;
}

// Sea zones are catalog data only and the seed carries the whole table, so a local zone it doesn't
// list was dropped upstream (the MEOW ecoregions, replaced by IHO sea areas). Runs before the
// merge: a dropped zone's name can come back under a new id, and names are unique. Its checklist
// rows cascade, and a region still pointing at it is reset to have its nearby zones recomputed.
// Users' own additions to a zone that comes back under its old name are set aside by name first,
// and restoreSeaZoneAdditions puts them on the new id once the merge has inserted it.
async function pruneSeaZonesFromSeed(client: PoolClient): Promise<number> {
  const seedZones = ident(tmpName("sea_zones"));
  await client.query(
    `CREATE TEMP TABLE sea_zone_additions_kept ON COMMIT DROP AS
     SELECT a.user_id, z.name, a.species_id, a.added_at
     FROM sea_zone_species_user_added a JOIN sea_zones z ON z.id = a.sea_zone_id
     WHERE NOT EXISTS (SELECT 1 FROM ${seedZones} s WHERE s.id::uuid = z.id)
       AND EXISTS (SELECT 1 FROM ${seedZones} s WHERE s.name = z.name)`,
  );
  const res = await client.query<{ id: string }>(
    `DELETE FROM sea_zones z WHERE NOT EXISTS (SELECT 1 FROM ${seedZones} s WHERE s.id::uuid = z.id) RETURNING z.id`,
  );
  const ids = res.rows.map((r) => r.id);
  if (ids.length > 0)
    await client.query(`UPDATE regions SET nearby_sea_zone_ids = NULL WHERE nearby_sea_zone_ids && $1::uuid[]`, [ids]);
  return ids.length;
}

async function restoreSeaZoneAdditions(client: PoolClient): Promise<number> {
  const res = await client.query(
    `INSERT INTO sea_zone_species_user_added (user_id, sea_zone_id, species_id, added_at)
     SELECT k.user_id, z.id, k.species_id, k.added_at
     FROM sea_zone_additions_kept k JOIN sea_zones z ON z.name = k.name
     ON CONFLICT DO NOTHING`,
  );
  await client.query(`DROP TABLE sea_zone_additions_kept`);
  return res.rowCount ?? 0;
}

// IUCN status is stored as a code with a CHECK constraint (migration 129). A seed published before
// that carries Wikidata labels ("least concern", "extinct_in_wild"), which would fail the check and
// roll back the whole update, so they're rewritten to codes first (anything unrecognized becomes
// NULL). Such a seed has no iucn_source either: its statuses all came from Wikidata, so that's
// added, keeping the merged row's source true to its status. Returns the seed's column list,
// grown by any column added here.
export async function normalizeSeedIucnStatus(client: PoolClient, seedColumns: string[]): Promise<string[]> {
  if (!seedColumns.includes("iucn_status")) return seedColumns;
  const tmp = ident(tmpName("species_traits"));
  const distinct = await client.query<{ v: string }>(
    `SELECT DISTINCT iucn_status AS v FROM ${tmp} WHERE iucn_status IS NOT NULL`,
  );
  const pairs = distinct.rows.map((r) => [r.v, normalizeIucnStatus(r.v)] as const).filter(([from, to]) => from !== to);
  if (pairs.length > 0) {
    await client.query(
      `UPDATE ${tmp} t SET iucn_status = m.code FROM unnest($1::text[], $2::text[]) AS m(raw, code) WHERE t.iucn_status = m.raw`,
      [pairs.map(([from]) => from), pairs.map(([, to]) => to)],
    );
  }
  if (seedColumns.includes("iucn_source")) return seedColumns;
  await client.query(`ALTER TABLE ${tmp} ADD COLUMN iucn_source text`);
  await client.query(`UPDATE ${tmp} SET iucn_source = 'wikidata' WHERE iucn_status IS NOT NULL`);
  return [...seedColumns, "iucn_source"];
}

// regions has a self-reference (parent_id) and an immediate UNIQUE(name, parent_id), so:
// - rows are inserted parent before child, each with its real parent_id from the start;
// - a region whose id changed upstream is matched by (name, parent) and keeps its local id, and
//   region_species rows are remapped onto that local id before they merge.
// - a local region the seed dropped that duplicates one it keeps is folded into it first.
async function mergeSelfReferencingTable(
  client: PoolClient,
  table: string,
  selfRefColumn: string,
  seedColumns: string[],
  loadedTables: Set<string>,
): Promise<number> {
  const cols = await sharedColumns(client, table, seedColumns);
  const pk = "id";
  const nameCol = "name"; // the natural-key column alongside parent_id; only regions has this shape today.
  const select = cols.map((c) => `${ident(c.name)}::${c.type}`);
  const colListNoParent = cols.filter((c) => c.name !== selfRefColumn).map((c) => ident(c.name));
  const parentCol = cols.find((c) => c.name === selfRefColumn);

  await client.query(
    `CREATE TEMP TABLE region_id_remap (seed_id uuid PRIMARY KEY, local_id uuid NOT NULL) ON COMMIT DROP`,
  );
  // Identity mappings for rows that already exist locally by id. Re-run after each insert pass to
  // pick up rows just inserted.
  const seedIdentity = () =>
    client.query(
      `INSERT INTO region_id_remap (seed_id, local_id)
       SELECT s.${ident(pk)}::uuid, s.${ident(pk)}::uuid FROM ${ident(tmpName(table))} s
       WHERE EXISTS (SELECT 1 FROM ${ident(table)} t WHERE t.${ident(pk)} = s.${ident(pk)}::uuid)
       ON CONFLICT (seed_id) DO NOTHING`,
    );
  await seedIdentity();

  const resolvedParent = (alias: string) =>
    `CASE WHEN ${alias}.${ident(selfRefColumn)} IS NULL THEN NULL
          ELSE (SELECT local_id FROM region_id_remap WHERE seed_id = ${alias}.${ident(selfRefColumn)}::uuid) END`;
  const ready = (alias: string) =>
    `NOT EXISTS (SELECT 1 FROM region_id_remap r WHERE r.seed_id = ${alias}.${ident(pk)}::uuid)
       AND (${alias}.${ident(selfRefColumn)} IS NULL
            OR EXISTS (SELECT 1 FROM region_id_remap r WHERE r.seed_id = ${alias}.${ident(selfRefColumn)}::uuid))`;

  // Bounded so a cycle or missing parent stops instead of looping forever. The real hierarchy is
  // only a few levels deep.
  for (let round = 0; round < 20; round++) {
    // A region with this (name, local parent) under a different id: claim it, don't duplicate it.
    const matched = await client.query(
      `INSERT INTO region_id_remap (seed_id, local_id)
       SELECT s.${ident(pk)}::uuid, t.${ident(pk)}
         FROM ${ident(tmpName(table))} s
         JOIN ${ident(table)} t ON t.${ident(nameCol)} = s.${ident(nameCol)} AND t.${ident(selfRefColumn)} IS NOT DISTINCT FROM ${resolvedParent("s")}
        WHERE ${ready("s")}
       ON CONFLICT (seed_id) DO NOTHING`,
    );
    // New rows, inserted with the resolved local parent id.
    const inserted = await client.query(
      `INSERT INTO ${ident(table)} (${colListNoParent.join(", ")}, ${ident(selfRefColumn)})
       SELECT ${select.filter((_, i) => cols[i].name !== selfRefColumn).join(", ")}, ${resolvedParent("s")}::${parentCol!.type}
         FROM ${ident(tmpName(table))} s
        WHERE ${ready("s")}
       ON CONFLICT (${ident(pk)}) DO NOTHING`,
    );
    await seedIdentity(); // covers the rows `inserted` just added
    if ((matched.rowCount ?? 0) + (inserted.rowCount ?? 0) === 0) break;
  }

  await client.query(
    `CREATE TEMP TABLE region_next ON COMMIT DROP AS
     SELECT r.local_id AS id, s.${ident(nameCol)}::text AS name, ${resolvedParent("s")}::uuid AS parent_id,
            l.ebird_region_code AS code
       FROM ${ident(tmpName(table))} s JOIN region_id_remap r ON r.seed_id = s.${ident(pk)}::uuid
       JOIN ${ident(table)} l ON l.id = r.local_id`,
  );
  await foldDroppedDuplicateRegions(client);

  // Update every other column, joined through the remap since a name-matched row's local id can
  // differ from the seed's.
  const updatable = cols.filter((c) => c.name !== pk);
  if (updatable.length > 0) {
    await client.query(
      `UPDATE ${ident(table)} t SET ${updatable
        .map((c) =>
          c.name === selfRefColumn
            ? `${ident(c.name)} = ${resolvedParent("s")}::${c.type}`
            : `${ident(c.name)} = s.${ident(c.name)}::${c.type}`,
        )
        .join(", ")}
         FROM ${ident(tmpName(table))} s
         JOIN region_id_remap r ON r.seed_id = s.${ident(pk)}::uuid
        WHERE t.${ident(pk)} = r.local_id`,
    );
  }

  // Apply the remap to region_species before it merges, so its rows land on local region ids.
  if (loadedTables.has("region_species")) {
    await client.query(
      `UPDATE ${ident(tmpName("region_species"))} t SET region_id = r.local_id::text
         FROM region_id_remap r WHERE r.seed_id = t.region_id::uuid AND r.seed_id != r.local_id`,
    );
  }
  if (loadedTables.has("gazetteer_places")) {
    for (const column of ["country_region_id", "province_region_id"])
      await client.query(
        `UPDATE ${ident(tmpName("gazetteer_places"))} t SET ${column} = r.local_id::text
           FROM region_id_remap r WHERE r.seed_id = t.${column}::uuid AND r.seed_id != r.local_id`,
      );
  }

  const countRes = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${ident(tmpName(table))}`);
  return Number(countRes.rows[0].n);
}

// Region ids held outside foreign keys. A derived table (the rollup) just loses the rows.
const REGION_ID_COLUMNS = [
  { table: "regions", column: "home_country_id" },
  { table: "regions", column: "populous_child_id" },
  { table: "gazetteer_places", column: "country_region_id" },
  { table: "gazetteer_places", column: "province_region_id" },
];
// Stores that keep region ids inside JSON: smart album rules, applied pack provinces, undo steps.
const REGION_ID_JSON_COLUMNS = [
  { table: "albums", column: "rules" },
  { table: "downloaded_packs", column: "applied_province_region_ids" },
  { table: "change_batches", column: "undo" },
  { table: "portfolios", column: "spec" },
  { table: "install_settings", column: "value" },
];
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// The 2026-10 catalog listed about 2,900 provinces twice, under the country and under its group.
// A later seed keeps one copy (often moving it into the slot the other holds) and drops the other.
// The dropped copy (a local region no seed row maps onto) is folded into the kept one: everything
// pointing at it moves over, then it's deleted. Without this the move breaks UNIQUE(name,
// parent_id) and rolls back the whole update. Needs region_next (each kept region's id, name and
// new parent) and leaves region_fold for the caller to count.
async function foldDroppedDuplicateRegions(client: PoolClient): Promise<void> {
  const started = Date.now();
  await client.query(`CREATE INDEX ON region_next (name)`);
  await client.query(`ANALYZE region_next`);
  // The tree as the seed leaves it: kept regions under their new parents, the rest where they are.
  await client.query(
    `CREATE TEMP TABLE region_tree ON COMMIT DROP AS
     SELECT id, name, parent_id, code, true AS kept FROM region_next
     UNION ALL SELECT r.id, r.name, r.parent_id, r.ebird_region_code, false FROM regions r WHERE NOT EXISTS (SELECT 1 FROM region_next n WHERE n.id = r.id)`,
  );
  await client.query(`CREATE INDEX ON region_tree (id)`);
  await client.query(`CREATE INDEX ON region_tree (parent_id, name)`);
  await client.query(`ANALYZE region_tree`);
  // A dropped region matches a kept one of its name in its own slot (which the kept one needs),
  // else a leaf one level apart (one copy under a group, the other beside that group). An
  // ambiguous match folds nothing. Two eBird codes that differ are two places, never folded;
  // compared before the update, since the seed may renumber the kept one's code.
  const sameCode = (a: string, b: string) => `(${a}.code IS NULL OR ${b}.code IS NULL OR ${a}.code = ${b}.code)`;
  await client.query(
    `CREATE TEMP TABLE region_fold ON COMMIT DROP AS
     WITH dropped AS (SELECT id, name, parent_id, code FROM region_tree WHERE NOT kept),
     leaf AS (SELECT id FROM region_tree t WHERE NOT EXISTS (SELECT 1 FROM region_tree c WHERE c.parent_id = t.id)),
     cand AS (
       SELECT d.id AS dup_id, k.id AS keep_id, 1 AS rank
         FROM dropped d JOIN region_next k ON k.name = d.name AND k.parent_id IS NOT DISTINCT FROM d.parent_id
        WHERE ${sameCode("d", "k")}
       UNION ALL
       SELECT d.id, k.id, 2 FROM dropped d JOIN region_next k ON k.name = d.name
         JOIN region_tree p ON p.id = k.parent_id JOIN leaf ld ON ld.id = d.id JOIN leaf lk ON lk.id = k.id
        WHERE p.parent_id = d.parent_id AND ${sameCode("d", "k")}
       UNION ALL
       SELECT d.id, k.id, 2 FROM dropped d JOIN region_next k ON k.name = d.name
         JOIN region_tree p ON p.id = d.parent_id JOIN leaf ld ON ld.id = d.id JOIN leaf lk ON lk.id = k.id
        WHERE p.parent_id = k.parent_id AND ${sameCode("d", "k")}
     ),
     best AS (SELECT dup_id, min(rank) AS rank FROM cand GROUP BY dup_id)
     SELECT c.dup_id, min(c.keep_id::text)::uuid AS keep_id
       FROM cand c JOIN best b ON b.dup_id = c.dup_id AND b.rank = c.rank
      GROUP BY c.dup_id HAVING count(DISTINCT c.keep_id) = 1`,
  );
  await client.query(`ALTER TABLE region_fold ADD PRIMARY KEY (dup_id)`);
  // A dropped region's own dropped children fold into the kept region's same-named children, then
  // chains (a child folding into a region that itself folds) resolve to the end of the chain.
  for (let round = 0; round < 20; round++) {
    const added = await client.query(
      `INSERT INTO region_fold (dup_id, keep_id)
       SELECT c.id, min(kc.id::text)::uuid FROM region_fold f
         JOIN region_tree c ON c.parent_id = f.dup_id AND NOT c.kept
         JOIN region_tree kc ON kc.parent_id = f.keep_id AND kc.name = c.name AND kc.id <> c.id
        WHERE ${sameCode("c", "kc")}
        GROUP BY c.id
       ON CONFLICT (dup_id) DO NOTHING`,
    );
    if ((added.rowCount ?? 0) === 0) break;
  }
  for (let round = 0; round < 20; round++) {
    const moved = await client.query(
      `UPDATE region_fold f SET keep_id = g.keep_id FROM region_fold g WHERE f.keep_id = g.dup_id AND g.dup_id <> f.dup_id`,
    );
    if ((moved.rowCount ?? 0) === 0) break;
  }
  await client.query(`DELETE FROM region_fold WHERE keep_id = dup_id OR keep_id IN (SELECT dup_id FROM region_fold)`);
  if (Number((await client.query(`SELECT count(*) AS n FROM region_fold`)).rows[0].n) === 0) return;
  await client.query(`ANALYZE region_fold`);

  // A pack's hotspots are one set per region and species: the kept region's set wins.
  await client.query(
    `DELETE FROM region_species_hotspots d USING region_fold f
      WHERE d.region_id = f.dup_id
        AND EXISTS (SELECT 1 FROM region_species_hotspots k WHERE k.region_id = f.keep_id AND k.species_id = d.species_id)`,
  );
  // A tier the user set on both copies keeps the one set last (setting one replaces its row).
  await client.query(
    `DELETE FROM user_tier_overrides k USING user_tier_overrides d, region_fold f
      WHERE d.region_id = f.dup_id AND k.region_id = f.keep_id
        AND k.user_id = d.user_id AND k.species_id = d.species_id AND k.created_at < d.created_at`,
  );
  const fks = await client.query<{ tbl: string; col: string }>(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = 'public.regions'::regclass AND cardinality(c.conkey) = 1
        AND NOT (c.conrelid = 'public.regions'::regclass AND a.attname = 'parent_id')`,
  );
  for (const { tbl, col } of fks.rows) await repointRegionColumn(client, tbl, col);

  // Children the seed doesn't place move under the kept region; ones it does get their parent below.
  await client.query(
    `UPDATE regions r SET parent_id = f.keep_id FROM region_fold f
      WHERE r.parent_id = f.dup_id
        AND NOT EXISTS (SELECT 1 FROM region_next n WHERE n.id = r.id)
        AND NOT EXISTS (SELECT 1 FROM region_fold g WHERE g.dup_id = r.id)`,
  );
  for (const { table, column } of REGION_ID_COLUMNS)
    await client.query(
      `UPDATE ${ident(table)} t SET ${ident(column)} = f.keep_id FROM region_fold f WHERE t.${ident(column)} = f.dup_id`,
    );
  await client.query(`DELETE FROM region_species_rollup x USING region_fold f WHERE x.region_id = f.dup_id`);
  await repointRegionIdsInJson(client);
  const folded = await client.query(`DELETE FROM regions r USING region_fold f WHERE r.id = f.dup_id`);
  log.info({ folded: folded.rowCount, ms: Date.now() - started }, "Folded duplicate regions into the ones kept");
}

// Moves one foreign key column's rows from each dropped region to its kept one. Where the kept
// region already has the row (a unique key), the kept row stays, takes any value only the dropped
// row had, and the dropped row goes. Set-based for plain unique keys; a key built on an expression
// or a predicate is resolved row by row (only small user tables have one).
async function repointRegionColumn(client: PoolClient, table: string, column: string): Promise<void> {
  const t = ident(table);
  const c = ident(column);
  const indexes = await client.query<{ cols: string[] | null; def: string }>(
    `SELECT CASE WHEN i.indexprs IS NULL AND i.indpred IS NULL
                 THEN ARRAY(SELECT a.attname::text FROM unnest(i.indkey) k JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k)
            END AS cols,
            pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i WHERE i.indrelid = $1::regclass AND i.indisunique`,
    [`public.${table}`],
  );
  const mentions = (def: string) => new RegExp(`[(, ]"?${column}"?[),: ]`).test(def);
  const plain = indexes.rows.filter((i) => i.cols?.includes(column) && !/NULLS NOT DISTINCT/.test(i.def));
  const rowByRow = indexes.rows.some((i) => !plain.includes(i) && mentions(i.def));

  if (rowByRow) {
    const rows = await client.query<{ ctid: string; keep_id: string }>(
      `SELECT t.ctid::text AS ctid, f.keep_id FROM ${t} t JOIN region_fold f ON t.${c} = f.dup_id`,
    );
    for (const row of rows.rows) {
      await client.query("SAVEPOINT repoint_region");
      try {
        await client.query(`UPDATE ${t} SET ${c} = $1 WHERE ctid = $2::tid`, [row.keep_id, row.ctid]);
        await client.query("RELEASE SAVEPOINT repoint_region");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT repoint_region");
        if ((err as { code?: string }).code !== "23505") throw err;
        await client.query(`DELETE FROM ${t} WHERE ctid = $1::tid`, [row.ctid]);
      }
    }
    return;
  }

  if (plain.length > 0) {
    const sameKey = (cols: string[], a: string, b: string) =>
      cols.filter((k) => k !== column).map((k) => `${a}.${ident(k)} = ${b}.${ident(k)}`);
    const key = plain[0].cols!;
    const others = (await columnTypes(client, table)).keys();
    const fillable = [...others].filter(
      (k) => !key.includes(k) && !plain.some((i) => i.cols!.includes(k)) && k !== column,
    );
    if (fillable.length > 0) {
      await client.query(
        `UPDATE ${t} k SET ${fillable.map((k) => `${ident(k)} = COALESCE(k.${ident(k)}, d.${ident(k)})`).join(", ")}
           FROM ${t} d JOIN region_fold f ON d.${c} = f.dup_id
          WHERE ${["k." + c + " = f.keep_id", ...sameKey(key, "k", "d")].join(" AND ")}
            AND (${fillable.map((k) => `(k.${ident(k)} IS NULL AND d.${ident(k)} IS NOT NULL)`).join(" OR ")})`,
      );
    }
    // Collides with the kept region's row, or with another dropped copy's row folding into it.
    const clash = plain.map((i) => {
      const keyMatch = (a: string, b: string) => [...sameKey(i.cols!, a, b)].join(" AND ") || "true";
      return `EXISTS (SELECT 1 FROM ${t} k WHERE k.${c} = f.keep_id AND ${keyMatch("k", "d")})
           OR EXISTS (SELECT 1 FROM ${t} o JOIN region_fold g ON o.${c} = g.dup_id
                       WHERE g.keep_id = f.keep_id AND ${keyMatch("o", "d")} AND (o.${c}, o.ctid) < (d.${c}, d.ctid))`;
    });
    await client.query(`DELETE FROM ${t} d USING region_fold f WHERE d.${c} = f.dup_id AND (${clash.join(" OR ")})`);
  }
  await client.query(`UPDATE ${t} t SET ${c} = f.keep_id FROM region_fold f WHERE t.${c} = f.dup_id`);
}

// Rewrites dropped region ids to kept ones inside JSON values, wherever they appear in a string,
// and drops a list's repeats the rewrite made. These stores are small.
async function repointRegionIdsInJson(client: PoolClient): Promise<void> {
  const fold = new Map(
    (await client.query<{ dup_id: string; keep_id: string }>(`SELECT dup_id, keep_id FROM region_fold`)).rows.map(
      (r) => [r.dup_id, r.keep_id],
    ),
  );
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(UUID_PATTERN, (id) => fold.get(id) ?? id);
    if (Array.isArray(value)) {
      const out = value.map(rewrite);
      const changed = out.some((v, i) => v !== value[i]);
      return changed && out.every((v) => typeof v === "string") ? [...new Set(out)] : out;
    }
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [rewrite(k) as string, rewrite(v)]));
    return value;
  };
  for (const { table, column } of REGION_ID_JSON_COLUMNS) {
    const c = ident(column);
    const rows = await client.query<{ ctid: string; value: unknown }>(
      `SELECT t.ctid::text AS ctid, t.${c} AS value FROM ${ident(table)} t
        WHERE t.${c} IS NOT NULL AND EXISTS (
          SELECT 1 FROM regexp_matches(t.${c}::text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g') m
            JOIN region_fold f ON f.dup_id = m[1]::uuid)`,
    );
    for (const row of rows.rows)
      await client.query(`UPDATE ${ident(table)} SET ${c} = $1::jsonb WHERE ctid = $2::tid`, [
        JSON.stringify(rewrite(row.value)),
        row.ctid,
      ]);
  }
}

// species_reference_photos is keyed by (species_id, photo_url), not id, because ids are per
// install. A seed id already used locally by a different photo gets a fresh uuid.
async function mergeReferencePhotos(client: PoolClient, seedColumns: string[]): Promise<number> {
  const cols = await sharedColumns(client, PHOTOS_TABLE, seedColumns);
  const keep = new Set(["id", "species_id", "photo_url", "display_path", "thumb_path"]);
  const select = cols.map((c) =>
    c.name === "id"
      ? `CASE WHEN EXISTS (SELECT 1 FROM ${PHOTOS_TABLE} x WHERE x.id = s.id::uuid) THEN gen_random_uuid() ELSE s.id::uuid END`
      : `s.${ident(c.name)}::${c.type}`,
  );
  const updatable = cols.filter((c) => !keep.has(c.name));
  const onConflict =
    updatable.length > 0
      ? `DO UPDATE SET ${updatable.map((c) => `${ident(c.name)} = EXCLUDED.${ident(c.name)}`).join(", ")}`
      : "DO NOTHING";
  const res = await client.query(
    `INSERT INTO ${PHOTOS_TABLE} (${cols.map((c) => ident(c.name)).join(", ")})
     SELECT ${select.join(", ")} FROM ${ident(tmpName(PHOTOS_TABLE))} s
     ON CONFLICT (species_id, photo_url) ${onConflict}`,
  );
  return res.rowCount ?? 0;
}

// A species whose main photo URL changed still has the old image cached locally, since merges
// never overwrite local paths. Clearing them makes the app fetch the new photo when next needed.
async function dropStaleMainPhotoCaches(client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE species s SET reference_display_path = NULL, reference_thumb_path = NULL
     FROM prev_main_photo p
     WHERE p.id = s.id AND p.reference_photo IS DISTINCT FROM s.reference_photo AND s.reference_display_path IS NOT NULL`,
  );
}

// Deletes gallery photos a species only had because the catalog once linked it to another
// species' iNaturalist taxon: the seed no longer lists the photo under this species but does list
// it under another. Photos from region downloads, which the seed simply doesn't carry, stay.
async function removeBorrowedGalleryPhotos(client: PoolClient): Promise<{ count: number; files: string[] }> {
  const res = await client.query<{ display_path: string | null; thumb_path: string | null }>(
    `DELETE FROM ${PHOTOS_TABLE} p
      WHERE NOT EXISTS (SELECT 1 FROM ${ident(tmpName(PHOTOS_TABLE))} s
                         WHERE s.species_id::uuid = p.species_id AND s.photo_url = p.photo_url)
        AND EXISTS (SELECT 1 FROM ${ident(tmpName(PHOTOS_TABLE))} s
                     WHERE s.species_id::uuid <> p.species_id AND s.photo_url = p.photo_url)
      RETURNING p.display_path, p.thumb_path`,
  );
  return {
    count: res.rows.length,
    files: res.rows.flatMap((r) => [r.display_path, r.thumb_path].filter((f): f is string => !!f)),
  };
}

// Deletes gallery photos the catalog blocklists (their vectors go with them via ON DELETE
// CASCADE). Returns how many, plus their cached files for deleting after commit.
async function removeBlockedPhotos(client: PoolClient): Promise<{ count: number; files: string[] }> {
  const res = await client.query<{ display_path: string | null; thumb_path: string | null }>(
    `DELETE FROM ${PHOTOS_TABLE} p USING reference_photo_blocklist b WHERE b.photo_url = p.photo_url
     RETURNING p.display_path, p.thumb_path`,
  );
  return {
    count: res.rows.length,
    files: res.rows.flatMap((r) => [r.display_path, r.thumb_path].filter((f): f is string => !!f)),
  };
}

// Older seeds still carry gallery embeddings keyed by the SEED's photo ids; map them onto this
// install's photo ids through (species_id, photo_url).
async function mergeLegacyGalleryEmbeddings(client: PoolClient): Promise<number> {
  const res = await client.query(
    `INSERT INTO ${LEGACY_GALLERY_TABLE} (reference_photo_id, species_id, embedding, model_version)
     SELECT p.id, p.species_id, g.embedding::real[], g.model_version
       FROM ${ident(tmpName(LEGACY_GALLERY_TABLE))} g
       JOIN ${ident(tmpName(PHOTOS_TABLE))} sp ON sp.id = g.reference_photo_id
       JOIN ${PHOTOS_TABLE} p ON p.species_id = sp.species_id::uuid AND p.photo_url = sp.photo_url
     ON CONFLICT (reference_photo_id) DO UPDATE
       SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
  );
  return res.rowCount ?? 0;
}

// The seed load in progress, for setup screens' time estimates: reading the file is the first
// half, merging the second, each table weighted by its share of the file.
let catalogLoad: LoadProgress | null = null;
export const catalogLoadProgress = (): LoadProgress | null => catalogLoad;

/** A seed download's bytes, timed like the load (which starts its own run once the file is in). */
export function noteSeedDownload(downloadedBytes: number | null, totalBytes: number | null): void {
  catalogLoad = downloadedBytes != null && totalBytes ? { processed: downloadedBytes, total: totalBytes } : null;
}

/** Applies a seed file already on disk in one transaction, recording `version` when known.
 * `onlyTables` merges just those tables and never records a version. */
export async function applyCatalogSeedFile(
  pool: Pool,
  seedPath: string,
  version: number | null,
  progress: Progress,
  onlyTables?: string[],
): Promise<Record<string, number>> {
  const fileBytes = statSync(seedPath).size;
  const total2 = 2 * fileBytes;
  catalogLoad = { processed: 0, total: total2 };
  const reading: Progress = {
    throwIfCancelled: () => progress.throwIfCancelled(),
    update: (u) => {
      progress.update(u);
      if (u.downloadedBytes != null) catalogLoad = { processed: Math.min(u.downloadedBytes, fileBytes), total: total2 };
    },
  };
  const spans = new Map<string, number>();
  let spanDone = 0;
  let spanTotal = 0;
  const merging = (table: string) => {
    catalogLoad = { processed: fileBytes + (spanTotal ? (fileBytes * spanDone) / spanTotal : 0), total: total2 };
    spanDone += spans.get(table) ?? 0;
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockReferenceData(client);
    // Region boundaries are the bulk of the seed's bytes, and lz4 writes them about 3x faster.
    await trySetLocal(client, "default_toast_compression", "lz4");
    progress.update({ phase: "applying", processed: 0, total: null });
    const loaded = await loadSeedIntoTempTables(
      client,
      seedPath,
      reading,
      onlyTables ? new Set(onlyTables) : undefined,
      spans,
    );

    // Main photo URLs before the merge, for dropStaleMainPhotoCaches.
    if (loaded.has("species")) {
      await client.query(`CREATE TEMP TABLE prev_main_photo ON COMMIT DROP AS SELECT id, reference_photo FROM species`);
    }
    const steps = MERGE_TABLES.filter((t) => loaded.has(t.table));
    const total = steps.length + (loaded.has(PHOTOS_TABLE) ? 1 : 0) + (loaded.has(LEGACY_GALLERY_TABLE) ? 1 : 0);
    for (const table of [...steps.map((t) => t.table), PHOTOS_TABLE, LEGACY_GALLERY_TABLE])
      if (loaded.has(table)) spanTotal += spans.get(table) ?? 0;
    const merged: Record<string, number> = {};
    let borrowedFiles: string[] = [];
    let filledEmpty = false;
    let done = 0;
    progress.update({ phase: "merging", processed: 0, total, downloadedBytes: null, totalBytes: null });

    for (const spec of steps) {
      progress.throwIfCancelled();
      progress.update({ currentItem: spec.table, processed: done });
      merging(spec.table);
      if (spec.table === "sea_zones") merged.sea_zonesRemoved = await pruneSeaZonesFromSeed(client);
      if (spec.table === "species_traits")
        loaded.set(spec.table, await normalizeSeedIucnStatus(client, loaded.get(spec.table)!));
      if (await isEmptyTable(client, spec.table)) {
        merged[spec.table] = await insertIntoEmptyTable(client, spec.table, loaded.get(spec.table)!);
        // The prune above can empty sea_zones on an update; additions it set aside still go back.
        if (spec.table === "sea_zones") merged.seaZoneAdditionsMoved = await restoreSeaZoneAdditions(client);
        filledEmpty = true;
        done++;
        continue;
      }
      if (spec.table === "region_species") {
        const replaced = await diffChecklistFromSeed(client, spec, loaded.get(spec.table)!);
        merged[spec.table] = replaced.written;
        merged.region_speciesRemoved = replaced.removed;
        done++;
        continue;
      }
      merged[spec.table] = await mergeGenericTable(client, spec, loaded.get(spec.table)!, new Set(loaded.keys()));
      if (spec.table === "regions") {
        const folded = Number((await client.query(`SELECT count(*) AS n FROM region_fold`)).rows[0].n);
        if (folded > 0) merged.regionsFolded = folded;
      }
      if (spec.table === "sea_zones") merged.seaZoneAdditionsMoved = await restoreSeaZoneAdditions(client);
      if (spec.table === "gazetteer_places") {
        const gone = await client.query(
          `DELETE FROM gazetteer_places g WHERE NOT EXISTS (SELECT 1 FROM ${ident(tmpName("gazetteer_places"))} s WHERE s.geoname_id::int = g.geoname_id)`,
        );
        merged.gazetteer_placesRemoved = gone.rowCount ?? 0;
      }
      if (spec.table in CHECKLIST_GROUP_COLUMN) {
        merged[`${spec.table}Removed`] = await pruneChecklistsFromSeed(
          client,
          spec.table,
          CHECKLIST_GROUP_COLUMN[spec.table],
        );
      }
      done++;
    }
    if (loaded.has(PHOTOS_TABLE)) {
      progress.throwIfCancelled();
      progress.update({ currentItem: PHOTOS_TABLE, processed: done });
      merging(PHOTOS_TABLE);
      if (await isEmptyTable(client, PHOTOS_TABLE)) {
        merged[PHOTOS_TABLE] = await insertIntoEmptyTable(client, PHOTOS_TABLE, loaded.get(PHOTOS_TABLE)!);
      } else {
        merged[PHOTOS_TABLE] = await mergeReferencePhotos(client, loaded.get(PHOTOS_TABLE)!);
        const borrowed = await removeBorrowedGalleryPhotos(client);
        borrowedFiles = borrowed.files;
        merged.borrowedPhotosRemoved = borrowed.count;
      }
      done++;
    }
    if (loaded.has(LEGACY_GALLERY_TABLE)) {
      progress.throwIfCancelled();
      progress.update({ currentItem: LEGACY_GALLERY_TABLE, processed: done });
      merging(LEGACY_GALLERY_TABLE);
      merged[LEGACY_GALLERY_TABLE] = loaded.has(PHOTOS_TABLE) ? await mergeLegacyGalleryEmbeddings(client) : 0;
      done++;
    }

    if (loaded.has("species")) await dropStaleMainPhotoCaches(client);
    // After every table, so a survivor's fresh rows are in before the old entry's are weighed.
    let movedCaptures: Array<{ userId: string; captureId: string }> = [];
    if (loaded.has("species_merges")) {
      const result = await applySpeciesMerges(client);
      merged.speciesMerged = result.merged;
      movedCaptures = result.captures;
    }
    let blockedFiles: string[] = [];
    if (loaded.has("reference_photo_blocklist")) {
      const removed = await removeBlockedPhotos(client);
      blockedFiles = removed.files;
      merged.blockedPhotosRemoved = removed.count;
    }

    progress.throwIfCancelled();
    catalogLoad = { processed: total2, total: total2 };
    // The fast path skipped the statement triggers that tell cached collection views and the
    // region rollup to refresh.
    if (filledEmpty) {
      await client.query(`SELECT nextval('collection_data_version'), nextval('region_checklist_version')`);
      // Nor the row trigger that stores each outline's boxes (migration 200) for regionAt.
      await client.query(
        `UPDATE regions SET outline_boxes = region_outline_boxes(boundary_geojson)
          WHERE boundary_geojson IS NOT NULL AND outline_boxes IS NULL`,
      );
    }
    if (version != null && !onlyTables) await setInstallSetting(client, CATALOG_SEED_VERSION_KEY, version);
    await client.query("COMMIT");
    invalidateSuggestionCache();
    // In the background: search falls back to a plain scan until it's built.
    if (filledEmpty) void ensureSpeciesSearchNames(true);
    void ensureRegionRollup();
    // Only after the rows are gone for good, so a rollback can't leave rows pointing at deleted files.
    for (const f of [...blockedFiles, ...borrowedFiles]) rmSync(f, { force: true });
    // Sidecars name the species, so a moved capture's are rewritten. Best-effort, in the background.
    void (async () => {
      for (const c of movedCaptures) await syncCaptureXmpSidecarsLogged(c.userId, c.captureId);
    })();
    // Photos under a species that's since been split go to the one living where they were taken.
    // After commit: re-filing a photo moves its files. A failure here leaves the photos to pick
    // by hand rather than reporting the committed update as failed.
    if (loaded.has("species_splits")) {
      try {
        const splits = await resolveSpeciesSplits();
        merged.splitPhotosRefiled = splits.moved;
        merged.splitPhotosToPick = splits.unresolved;
      } catch (err) {
        log.error({ err }, "Couldn't re-file photos after species splits");
      }
    }
    // A place's region-only town or area becomes its nearest town once the town list is in.
    if (loaded.has("gazetteer_places")) {
      try {
        merged.placeLocalitiesUpgraded = await upgradeRegionLocalities();
      } catch (err) {
        log.error({ err }, "Couldn't name places after their nearest towns");
      }
    }
    progress.update({ processed: total, currentItem: null });
    return merged;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    catalogLoad = null;
    client.release();
  }
}

async function downloadSeed(
  manifest: CatalogManifest,
  ctx: Pick<JobContext<unknown>, "signal" | "update">,
): Promise<string> {
  mkdirSync(CATALOG_DOWNLOAD_DIR, { recursive: true });
  const { url, sha256 } = catalogSeedAsset(manifest);
  const dest = path.join(CATALOG_DOWNLOAD_DIR, `lifer-catalog-seed-${manifest.version}.sql.gz`);
  ctx.update({ phase: "downloading", downloadedBytes: 0, totalBytes: manifest.seed?.bytes ?? null });
  try {
    await downloadResumable(url, dest, {
      signal: ctx.signal,
      expectedSha256: sha256,
      label: "the catalog update",
      onProgress: (downloadedBytes, totalBytes) => {
        ctx.update({ downloadedBytes, totalBytes });
        noteSeedDownload(downloadedBytes, totalBytes);
      },
    });
  } catch (err) {
    noteSeedDownload(null, null);
    throw err;
  }
  return dest;
}

// Removes downloaded seeds other than `keep` (older versions, or everything after success).
function pruneDownloads(keep: string | null): void {
  if (!existsSync(CATALOG_DOWNLOAD_DIR)) return;
  for (const name of readdirSafe(CATALOG_DOWNLOAD_DIR)) {
    const full = path.join(CATALOG_DOWNLOAD_DIR, name);
    if (full !== keep && full !== `${keep}.part` && name.startsWith("lifer-catalog-seed-"))
      rmSync(full, { force: true });
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export const catalogUpdate = createJob<CatalogMergeResult>("catalog-update");

async function runCatalogUpdate(pool: Pool, ctx: JobContext<CatalogMergeResult>): Promise<CatalogMergeResult> {
  const manifest = await fetchCatalogManifest(ctx.signal);
  const seedPath = await downloadSeed(manifest, ctx);
  pruneDownloads(seedPath);
  ctx.throwIfCancelled();
  const merged = await applyCatalogSeedFile(pool, seedPath, manifest.version, ctx);
  rmSync(seedPath, { force: true });

  // Reference vectors only matter with the CLIP model installed. A failure here doesn't undo the
  // committed catalog update.
  let referenceVectors: ReferenceVectorsResult | null = null;
  if (isModelDownloaded()) {
    try {
      referenceVectors = await runGalleryEmbeddingsUpdate(pool, ctx, { manifest });
    } catch (err) {
      if (err instanceof JobCancelledError || ctx.signal.aborted) throw err;
      log.warn({ err }, "[catalog-update] reference vectors refresh failed");
      const failed = { status: "failed" as const, error: describeError(err) };
      referenceVectors = { gallery: failed, speciesImage: failed, speciesText: failed };
    }
  }
  return { merged, referenceVectors };
}

/** Starts the Settings catalog update in the background. Returns false if one is already running. */
export function startCatalogUpdateJob(pool: Pool): boolean {
  return catalogUpdate.start((ctx) => runCatalogUpdate(pool, ctx));
}

const noProgress: Progress = { update: () => {}, throwIfCancelled: () => {} };

export const BUNDLED_SEED_FILE = "lifer-catalog-seed.sql.gz";
export const BUNDLED_REGIONS_FILE = "lifer-catalog-regions.sql.gz";

/** The Docker image's bundled copy of the published manifest. regionsOnly is added by the image
 *  build (scripts/fetch-catalog-seed.js) for the regions-only file it derives from the seed. */
type BundledManifest = Partial<CatalogManifest> & { regionsOnly?: { sha256?: string } };

export interface BundledSeed {
  path: string;
  version: number | null;
  /** The regions-only copy, when present and matching its checksum. */
  regionsPath: string | null;
}

async function assertSha256(file: string, expected: string, label: string): Promise<void> {
  const actual = await sha256OfFile(file);
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `${label} (${file}) doesn't match the checksum in its manifest, so Lifer won't load it. ` +
        "The image may be damaged: pull it again, or run the catalog update from Settings.",
    );
  }
}

/** The catalog seed baked into the Docker image, checked against the sha256 in the manifest
 *  bundled next to it. Throws on a mismatch rather than loading it. Without a manifest (or one
 *  from before seeds had checksums) there's nothing to check it against, and it's used as is. */
export async function verifiedBundledSeed(dir: string = BUNDLED_CATALOG_SEED_DIR): Promise<BundledSeed | null> {
  const seedPath = path.join(dir, BUNDLED_SEED_FILE);
  if (!existsSync(seedPath)) return null;
  let manifest: BundledManifest | null = null;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "catalog-manifest.json"), "utf8")) as BundledManifest;
  } catch {
    // No bundled manifest: apply without recording a version, so Settings offers the update.
  }
  const version = typeof manifest?.version === "number" ? manifest.version : null;
  if (manifest?.seed?.sha256) await assertSha256(seedPath, manifest.seed.sha256, "The bundled catalog seed");

  // Derived from the checked seed at image build time, with its own checksum. Without one, the
  // first-boot regions pass reads the full seed instead.
  const regionsFile = path.join(dir, BUNDLED_REGIONS_FILE);
  let regionsPath: string | null = null;
  if (existsSync(regionsFile) && manifest?.regionsOnly?.sha256) {
    await assertSha256(regionsFile, manifest.regionsOnly.sha256, "The bundled regions file");
    regionsPath = regionsFile;
  }
  return { path: seedPath, version, regionsPath };
}

// First-boot seed progress. A fresh server loads regions first so onboarding can list countries
// immediately, then everything else in the background. Pack downloads wait for the whole load.
let firstBootSeedState: "running" | "failed" | null = null;
let firstBootSeed: Promise<unknown> = Promise.resolve();
export function catalogFirstBootState(): "running" | "failed" | null {
  return firstBootSeedState;
}

/** Resolves once any first-boot catalog load has finished; throws if it failed. */
export async function waitForFirstBootCatalog(): Promise<void> {
  await firstBootSeed.catch(() => {});
  if (firstBootSeedState === "failed") {
    throw new Error("Lifer couldn't load its species catalog. Restart the server to try again.");
  }
}

/** Fills an empty catalog on first boot, preferring the bundled seed (image or desktop app). Callers
 * swallow failures so startup is never blocked. */
export function seedCatalogIfEmpty(pool: Pool): Promise<{ seeded: boolean; merged?: Record<string, number> }> {
  // Marked running before the first await so nothing asking in between sees "not loading".
  firstBootSeedState = "running";
  const run = (async () => {
    const res = await pool.query(`SELECT 1 FROM species LIMIT 1`);
    if (res.rowCount) return { seeded: false };
    return seedEmptyCatalog(pool);
  })().then(
    (result) => {
      firstBootSeedState = null;
      return result;
    },
    (err) => {
      firstBootSeedState = "failed";
      throw err;
    },
  );
  firstBootSeed = run;
  return run;
}

async function seedEmptyCatalog(pool: Pool): Promise<{ seeded: boolean; merged?: Record<string, number> }> {
  const bundled = await verifiedBundledSeed();
  let seedPath: string;
  let version: number | null;
  if (bundled) {
    ({ path: seedPath, version } = bundled);
  } else {
    // Checked against the manifest's sha256 as it downloads (downloadSeed).
    const manifest = await fetchCatalogManifest();
    seedPath = await downloadSeed(manifest, { signal: new AbortController().signal, update: () => {} });
    version = manifest.version;
  }
  try {
    // Regions first, committed, so the country list works while the rest loads. Uses the image's
    // regions-only copy when present; the full pass re-merges regions harmlessly.
    await applyCatalogSeedFile(pool, bundled?.regionsPath ?? seedPath, null, noProgress, ["regions"]);
    const merged = await applyCatalogSeedFile(pool, seedPath, version, noProgress);
    return { seeded: true, merged };
  } finally {
    if (!bundled) rmSync(seedPath, { force: true });
  }
}
