// Merges a published catalog seed (a gzipped pg_dump of the catalog tables) into an existing
// install: the Settings catalog update and the Docker first-boot seed.
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
import { normalizeIucnStatus } from "@lifer/shared";
import { recordRestoredSeedVersion } from "./restoredSeedVersion.js";

export { fetchCatalogManifest, type CatalogManifest };

export const CATALOG_DOWNLOAD_DIR = path.join(APP_DATA_DIR, "catalog-downloads");
const CATALOG_SEED_VERSION_KEY = "catalog_seed_version";

export async function getAppliedCatalogVersion(db: Pool | PoolClient): Promise<number | null> {
  const v = await getInstallSetting<number>(db, CATALOG_SEED_VERSION_KEY);
  return v == null ? null : Number(v);
}

// userId is unused (the version is per-install); kept so existing callers compile.
export async function checkCatalogUpdate(
  pool: Pool,
  _userId?: string,
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
 * (unquoted) each table's COPY block carried. */
async function loadSeedIntoTempTables(
  client: PoolClient,
  seedPath: string,
  progress: Progress,
  onlyTables?: Set<string>,
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
      await client.query(
        `CREATE TEMP TABLE ${ident(tmpName(table))} (${columns.map((c) => `${ident(c)} text`).join(", ")}) ON COMMIT DROP`,
      );
      await copyInto(client, `COPY ${ident(tmpName(table))} (${columns.map(ident).join(", ")}) FROM STDIN`, blockBody());
      loaded.set(table, columns);
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
  if (unknown.length > 0) log.warn(`[catalog-update] ${table}: ignoring columns not in this schema: ${unknown.join(", ")}`);
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
  const assign = (column: string) =>
    keepLocalWithheldPhoto && LOCAL_WITHHELD_PHOTO_COLUMNS.has(column)
      ? `${ident(column)} = CASE WHEN EXCLUDED.photo_withheld AND EXCLUDED.reference_photo IS NULL ` +
        `THEN ${ident(table)}.${ident(column)} ELSE EXCLUDED.${ident(column)} END`
      : `${ident(column)} = EXCLUDED.${ident(column)}`;
  const onConflict =
    updatable.length > 0 ? `DO UPDATE SET ${updatable.map((c) => assign(c.name)).join(", ")}` : "DO NOTHING";
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
  if (ids.length > 0) await client.query(`UPDATE regions SET nearby_sea_zone_ids = NULL WHERE nearby_sea_zone_ids && $1::uuid[]`, [ids]);
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
  const distinct = await client.query<{ v: string }>(`SELECT DISTINCT iucn_status AS v FROM ${tmp} WHERE iucn_status IS NOT NULL`);
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

  await client.query(`CREATE TEMP TABLE region_id_remap (seed_id uuid PRIMARY KEY, local_id uuid NOT NULL) ON COMMIT DROP`);
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

  // Update every other column, joined through the remap since a name-matched row's local id can
  // differ from the seed's.
  const updatable = cols.filter((c) => c.name !== pk);
  if (updatable.length > 0) {
    await client.query(
      `UPDATE ${ident(table)} t SET ${updatable
        .map((c) => (c.name === selfRefColumn ? `${ident(c.name)} = ${resolvedParent("s")}::${c.type}` : `${ident(c.name)} = s.${ident(c.name)}::${c.type}`))
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

  const countRes = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${ident(tmpName(table))}`);
  return Number(countRes.rows[0].n);
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

// Deletes gallery photos the catalog blocklists (their vectors go with them via ON DELETE
// CASCADE). Returns how many, plus their cached files for deleting after commit.
async function removeBlockedPhotos(client: PoolClient): Promise<{ count: number; files: string[] }> {
  const res = await client.query<{ display_path: string | null; thumb_path: string | null }>(
    `DELETE FROM ${PHOTOS_TABLE} p USING reference_photo_blocklist b WHERE b.photo_url = p.photo_url
     RETURNING p.display_path, p.thumb_path`,
  );
  return { count: res.rows.length, files: res.rows.flatMap((r) => [r.display_path, r.thumb_path].filter((f): f is string => !!f)) };
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

/** Applies a seed file already on disk in one transaction, recording `version` when known.
 * `onlyTables` merges just those tables and never records a version. */
export async function applyCatalogSeedFile(
  pool: Pool,
  seedPath: string,
  version: number | null,
  progress: Progress,
  onlyTables?: string[],
): Promise<Record<string, number>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockReferenceData(client);
    progress.update({ phase: "applying", processed: 0, total: null });
    const loaded = await loadSeedIntoTempTables(client, seedPath, progress, onlyTables ? new Set(onlyTables) : undefined);

    // Main photo URLs before the merge, for dropStaleMainPhotoCaches.
    if (loaded.has("species")) {
      await client.query(`CREATE TEMP TABLE prev_main_photo ON COMMIT DROP AS SELECT id, reference_photo FROM species`);
    }
    const steps = MERGE_TABLES.filter((t) => loaded.has(t.table));
    const total = steps.length + (loaded.has(PHOTOS_TABLE) ? 1 : 0) + (loaded.has(LEGACY_GALLERY_TABLE) ? 1 : 0);
    const merged: Record<string, number> = {};
    let done = 0;
    progress.update({ phase: "merging", processed: 0, total, downloadedBytes: null, totalBytes: null });

    for (const spec of steps) {
      progress.throwIfCancelled();
      progress.update({ currentItem: spec.table, processed: done });
      if (spec.table === "sea_zones") merged.sea_zonesRemoved = await pruneSeaZonesFromSeed(client);
      if (spec.table === "species_traits") loaded.set(spec.table, await normalizeSeedIucnStatus(client, loaded.get(spec.table)!));
      merged[spec.table] = await mergeGenericTable(client, spec, loaded.get(spec.table)!, new Set(loaded.keys()));
      if (spec.table === "sea_zones") merged.seaZoneAdditionsMoved = await restoreSeaZoneAdditions(client);
      if (spec.table in CHECKLIST_GROUP_COLUMN) {
        merged[`${spec.table}Removed`] = await pruneChecklistsFromSeed(client, spec.table, CHECKLIST_GROUP_COLUMN[spec.table]);
      }
      done++;
    }
    if (loaded.has(PHOTOS_TABLE)) {
      progress.throwIfCancelled();
      progress.update({ currentItem: PHOTOS_TABLE, processed: done });
      merged[PHOTOS_TABLE] = await mergeReferencePhotos(client, loaded.get(PHOTOS_TABLE)!);
      done++;
    }
    if (loaded.has(LEGACY_GALLERY_TABLE)) {
      progress.throwIfCancelled();
      progress.update({ currentItem: LEGACY_GALLERY_TABLE, processed: done });
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
    if (version != null && !onlyTables) await setInstallSetting(client, CATALOG_SEED_VERSION_KEY, version);
    await client.query("COMMIT");
    invalidateSuggestionCache();
    // Only after the rows are gone for good, so a rollback can't leave rows pointing at deleted files.
    for (const f of blockedFiles) rmSync(f, { force: true });
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
    progress.update({ processed: total, currentItem: null });
    return merged;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function downloadSeed(manifest: CatalogManifest, ctx: Pick<JobContext<unknown>, "signal" | "update">): Promise<string> {
  mkdirSync(CATALOG_DOWNLOAD_DIR, { recursive: true });
  const { url, sha256 } = catalogSeedAsset(manifest);
  const dest = path.join(CATALOG_DOWNLOAD_DIR, `lifer-catalog-seed-${manifest.version}.sql.gz`);
  ctx.update({ phase: "downloading", downloadedBytes: 0, totalBytes: manifest.seed?.bytes ?? null });
  await downloadResumable(url, dest, {
    signal: ctx.signal,
    expectedSha256: sha256,
    label: "the catalog update",
    onProgress: (downloadedBytes, totalBytes) => ctx.update({ downloadedBytes, totalBytes }),
  });
  return dest;
}

// Removes downloaded seeds other than `keep` (older versions, or everything after success).
function pruneDownloads(keep: string | null): void {
  if (!existsSync(CATALOG_DOWNLOAD_DIR)) return;
  for (const name of readdirSafe(CATALOG_DOWNLOAD_DIR)) {
    const full = path.join(CATALOG_DOWNLOAD_DIR, name);
    if (full !== keep && full !== `${keep}.part` && name.startsWith("lifer-catalog-seed-")) rmSync(full, { force: true });
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
// Kept as the status object for existing callers (`catalogUpdateJob.running`).
export const catalogUpdateJob = catalogUpdate.status;

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
export function startCatalogUpdateJob(pool: Pool, _userId?: string): boolean {
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

/** Fills an empty catalog on first boot, preferring the seed baked into the image. Callers
 * swallow failures so startup is never blocked. */
export function seedCatalogIfEmpty(pool: Pool): Promise<{ seeded: boolean; merged?: Record<string, number> }> {
  // Marked running before the first await so nothing asking in between sees "not loading".
  firstBootSeedState = "running";
  const run = (async () => {
    const res = await pool.query<{ count: string }>(`SELECT count(*) FROM species`);
    if (Number(res.rows[0].count) > 0) {
      // A catalog the desktop app restored before the API started: record its version.
      await recordRestoredSeedVersion(pool).catch((err) => log.warn({ err }, "[catalog] couldn't record the restored seed's version"));
      return { seeded: false };
    }
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
