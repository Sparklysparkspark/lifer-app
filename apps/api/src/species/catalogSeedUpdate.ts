// Merges a published catalog seed (a gzipped pg_dump of the catalog tables, see
// packages/data-pipeline/src/scripts/build-catalog-seed.ts) into an existing install: the
// Settings "Species catalog" update, and the Docker first-boot seed (seedCatalogIfEmpty).
// The desktop app's very first restore into an empty database is embedded_db.rs instead.
//
// How it works, and why:
// - Download to a file under APP_DATA_DIR (resumable, stall timeout, sha256 checked), so a failed
//   apply never re-downloads and nothing large is held in memory.
// - Stream the gzip line by line. pg_dump's COPY blocks are already COPY text format, so each
//   block is piped unparsed into a temp table with `COPY ... FROM STDIN`. Temp columns are all
//   text, so a seed built from a slightly newer or older schema still loads.
// - Merge each temp table into the real one with a single INSERT ... SELECT ... ON CONFLICT
//   (typed casts per column), in FK-safe order, never overwriting this install's local file-path
//   columns (the seed always carries them NULL).
// - All of it runs in ONE transaction, and the applied version is recorded in the same
//   transaction, so a crash or cancel leaves the catalog exactly as it was.
//
// Pure `pg` driver, no psql: the packaged app has no psql binary for Node to call, and the Docker
// image can't be assumed to have one either.
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Pool, PoolClient } from "pg";
import { APP_DATA_DIR, BUNDLED_CATALOG_SEED_DIR } from "../config.js";
import { createJob, describeError, JobCancelledError, type JobContext } from "../lib/job.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";
import { copyInto, readLines } from "../lib/pgCopy.js";
import { downloadResumable } from "../lib/resumableDownload.js";
import { catalogSeedAsset, fetchCatalogManifest, type CatalogManifest } from "./catalogManifest.js";
import { isModelDownloaded } from "./embeddings.js";
import { runGalleryEmbeddingsUpdate, type ReferenceVectorsResult } from "./galleryEmbeddingsAsset.js";
import { invalidateSuggestionCache } from "./embeddings.js";

export { fetchCatalogManifest, type CatalogManifest };

export const CATALOG_DOWNLOAD_DIR = path.join(APP_DATA_DIR, "catalog-downloads");
const CATALOG_SEED_VERSION_KEY = "catalog_seed_version";

export async function getAppliedCatalogVersion(db: Pool | PoolClient): Promise<number | null> {
  const v = await getInstallSetting<number>(db, CATALOG_SEED_VERSION_KEY);
  return v == null ? null : Number(v);
}

// userId is unused since the version became per-install (migration 103); kept so callers that
// still pass it compile.
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
  { table: "species", pkColumns: ["id"], excludeFromUpdate: ["reference_display_path", "reference_thumb_path"] },
  { table: "species_traits", pkColumns: ["species_id"], excludeFromUpdate: [] },
  { table: "species_rarity", pkColumns: ["species_id"], excludeFromUpdate: [] },
  { table: "regions", pkColumns: ["id"], excludeFromUpdate: [] },
  { table: "region_species", pkColumns: ["region_id", "species_id"], excludeFromUpdate: [] },
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
  if (unknown.length > 0) console.warn(`[catalog-update] ${table}: ignoring columns not in this schema: ${unknown.join(", ")}`);
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
  const select = cols.map((c) => `${ident(c.name)}::${c.type}`);
  const updatable = cols.filter((c) => !pkColumns.includes(c.name) && !excludeFromUpdate.includes(c.name));
  const onConflict =
    updatable.length > 0
      ? `DO UPDATE SET ${updatable.map((c) => `${ident(c.name)} = EXCLUDED.${ident(c.name)}`).join(", ")}`
      : "DO NOTHING";
  const res = await client.query(
    `INSERT INTO ${ident(table)} (${cols.map((c) => ident(c.name)).join(", ")})
     SELECT ${select.join(", ")} FROM ${ident(tmpName(table))}
     ON CONFLICT (${pkColumns.map(ident).join(", ")}) ${onConflict}`,
  );
  return res.rowCount ?? 0;
}

// regions has both a self-reference (a province's parent_id points at its country) and a
// UNIQUE(name, parent_id) constraint (migration 049), checked immediately, not deferred, which
// created two separate real failures:
//
// 1. The old approach (insert every row with parent_id forced NULL, then fix it up in a second
//    pass) could insert two DIFFERENT brand-new regions that happen to share a name with
//    parent_id NULL at the same instant, colliding even though their real, final parents were
//    never the same. Fixed by inserting in topological order (parent before child) so every
//    row's REAL parent_id is used from the moment it's inserted - see the round-based loop below.
//
// 2. Separately (confirmed live, on a real update against a real install): a region's canonical
//    id can change upstream (this project has a whole migration, 004_dedupe_regions.sql, for
//    exactly this kind of cleanup) - an install that last synced before such a change has an
//    existing row for, say, Georgia under an OLD id, while the current seed publishes Georgia
//    under a NEW id. Neither the old NULL-parent approach nor the topological-order fix above
//    caught this: `id` doesn't match, so it tries to INSERT a second Georgia, which collides on
//    (name, parent_id) with the first. Same fix species_reference_photos already uses for its
//    own id-mismatch problem: match the existing row by its real natural key (name + parent)
//    when the id doesn't, and keep the LOCAL id rather than the seed's. Every other table that
//    references a region by id (currently just region_species) gets that mapping applied to its
//    own temp table before it merges, so a region_species row that names the seed's "new"
//    Georgia id ends up attached to the existing local row instead of a FK a region that was
//    never inserted.
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
  // Seed identity mappings for every row that already exists locally by id (the common case:
  // nothing changed). Re-run after each insert pass below to pick up rows just inserted, so a
  // single piece of SQL covers both "already had it" and "just inserted it".
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

  // Bounded, not unbounded: a real cycle or a parent this seed never sent (data bug, not this
  // code's job to paper over) must fail loudly, via ROLLBACK, rather than loop forever. The
  // real hierarchy here is a handful of levels deep (continent -> country -> province/state ->
  // subdivision at most), so this ceiling is generous headroom, not a tight fit.
  for (let round = 0; round < 20; round++) {
    // First: does a region with this exact (name, resolved-local-parent) already exist under a
    // different id? Claim it rather than inserting a duplicate.
    const matched = await client.query(
      `INSERT INTO region_id_remap (seed_id, local_id)
       SELECT s.${ident(pk)}::uuid, t.${ident(pk)}
         FROM ${ident(tmpName(table))} s
         JOIN ${ident(table)} t ON t.${ident(nameCol)} = s.${ident(nameCol)} AND t.${ident(selfRefColumn)} IS NOT DISTINCT FROM ${resolvedParent("s")}
        WHERE ${ready("s")}
       ON CONFLICT (seed_id) DO NOTHING`,
    );
    // Then: genuinely new rows (not matched above), inserted with the resolved local parent id.
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

  // Existing rows (including newly-inserted and newly-matched-by-name ones): update every other
  // column to the seed's real value, joined through the remap rather than assuming id equality,
  // since a name-matched row's local id can differ from the seed's.
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

  // Any other loaded table that references this one by id gets the same remap applied to its own
  // temp table before it merges, so a row naming the seed's id for a since-remapped region lands
  // on the local id instead. Currently only region_species does.
  if (loadedTables.has("region_species")) {
    await client.query(
      `UPDATE ${ident(tmpName("region_species"))} t SET region_id = r.local_id::text
         FROM region_id_remap r WHERE r.seed_id = t.region_id::uuid AND r.seed_id != r.local_id`,
    );
  }

  const countRes = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${ident(tmpName(table))}`);
  return Number(countRes.rows[0].n);
}

// species_reference_photos' real key is (species_id, photo_url) (migration 003), not `id`: ids
// are generated per install (a pack-downloaded photo has its own local id). So conflicts resolve
// on the natural key and never change a local id. A seed id that happens to exist locally for a
// different photo gets a fresh uuid instead of failing the update on the primary key.
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

// A species whose main photo URL this catalog changed (a map replaced by a real photo, say)
// still has the OLD image cached locally: the local path columns are deliberately never
// overwritten by a merge. Clearing them makes the app fetch the new photo (from a pack or the URL)
// the next time it's needed, instead of showing the old file forever.
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

/** Applies a seed file already on disk, in one transaction. `version` (when known) is recorded
 * as applied in that same transaction. */
/** `onlyTables` merges just those tables (used to get regions in first on a fresh server) and
 *  never records a catalog version, since the catalog isn't complete after it. */
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
    progress.update({ phase: "applying", processed: 0, total: null });
    const loaded = await loadSeedIntoTempTables(client, seedPath, progress, onlyTables ? new Set(onlyTables) : undefined);

    // Each species' main photo URL before the merge, to spot the ones this catalog changes (see
    // dropStaleMainPhotoCaches below).
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
      merged[spec.table] = await mergeGenericTable(client, spec, loaded.get(spec.table)!, new Set(loaded.keys()));
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

  // The reference vectors are only usable with the CLIP model, so they're refreshed here only
  // when it's installed. A failure here doesn't undo the catalog update that already committed.
  let referenceVectors: ReferenceVectorsResult | null = null;
  if (isModelDownloaded()) {
    try {
      referenceVectors = await runGalleryEmbeddingsUpdate(pool, ctx, { manifest });
    } catch (err) {
      if (err instanceof JobCancelledError || ctx.signal.aborted) throw err;
      console.warn("[catalog-update] reference vectors refresh failed", err);
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

function bundledSeed(): { path: string; version: number | null } | null {
  const seedPath = path.join(BUNDLED_CATALOG_SEED_DIR, "lifer-catalog-seed.sql.gz");
  if (!existsSync(seedPath)) return null;
  let version: number | null = null;
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(BUNDLED_CATALOG_SEED_DIR, "catalog-manifest.json"), "utf8"),
    ) as CatalogManifest;
    version = typeof manifest.version === "number" ? manifest.version : null;
  } catch {
    // No bundled manifest: apply without recording a version, so Settings offers the update.
  }
  return { path: seedPath, version };
}

// First-boot seed progress. A fresh server loads its catalog in the background right after it
// starts: regions first (about a second) so onboarding can list countries immediately, then
// everything else (a minute on a laptop, several on a NAS). Pack downloads wait for the whole
// thing before writing anything (waitForFirstBootCatalog), so a user can pick and start a
// download without ever seeing this.
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

/** Fills an empty catalog on server startup (Docker/self-hosted first boot). Prefers the seed
 * baked into the image; falls back to downloading it. Callers log and swallow failures so a
 * failed auto-seed never blocks startup. */
export function seedCatalogIfEmpty(pool: Pool): Promise<{ seeded: boolean; merged?: Record<string, number> }> {
  // Marked running before the first await so nothing asking in between sees "not loading".
  firstBootSeedState = "running";
  const run = (async () => {
    const res = await pool.query<{ count: string }>(`SELECT count(*) FROM species`);
    if (Number(res.rows[0].count) > 0) return { seeded: false };
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
  const bundled = bundledSeed();
  let seedPath: string;
  let version: number | null;
  if (bundled) {
    ({ path: seedPath, version } = bundled);
  } else {
    const manifest = await fetchCatalogManifest();
    seedPath = await downloadSeed(manifest, { signal: new AbortController().signal, update: () => {} });
    version = manifest.version;
  }
  try {
    // Regions on their own first, committed, so the country list works while the rest loads.
    // The Docker image ships a regions-only copy for this (fetch-catalog-seed.js), which reads
    // in well under a second; the full file works too, just slower. The full pass below merges
    // regions again by id, which is a no-op for identical rows.
    const regionsOnly = path.join(BUNDLED_CATALOG_SEED_DIR, "lifer-catalog-regions.sql.gz");
    await applyCatalogSeedFile(pool, bundled && existsSync(regionsOnly) ? regionsOnly : seedPath, null, noProgress, ["regions"]);
    const merged = await applyCatalogSeedFile(pool, seedPath, version, noProgress);
    return { seeded: true, merged };
  } finally {
    if (!bundled) rmSync(seedPath, { force: true });
  }
}
