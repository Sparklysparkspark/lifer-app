// Openly licensed gallery vectors (plan item D-06): CLIP vectors of CC0, CC BY and public domain
// iNaturalist photos, with each photo's credit, written as PRVE files to data/open-vectors/.
// Writes files only, never the database: importing them waits for a republish.
//
//   npm run open-vectors -w data-pipeline                         every group, birds first
//   npm run open-vectors -w data-pipeline -- --taxa=birds,mammals  just these groups
//   npm run open-vectors -w data-pipeline -- --per-species=10      more photos per species (default 6)
//   npm run open-vectors -w data-pipeline -- --limit=50            stop after 50 species (a trial run)
//   npm run open-vectors -w data-pipeline -- --dry-run --limit=5   show the picks, fetch no photos
//   npm run open-vectors -w data-pipeline -- --refresh-metadata    use iNaturalist's newest dump
//
// Rerun the same command to resume: finished species, embedded photos, the downloads and the
// index are all kept. Steps:
//   1. iNaturalist Open Data metadata (taxa, observers, observations, photos; about 34 GB), resumed
//      by byte range and checked against S3's ETag.
//   2. An index of up to 80 candidate photos per species (DuckDB): research grade, the photo's own
//      licence CC0, CC BY or public domain, at least 500 px, a few per observer.
//   3. Per Lifer species (read-only from DATABASE_URL): match by iNaturalist taxon id, then by
//      name or synonym; pick photos from different observers, places and seasons; skip species
//      that already have enough open gallery vectors; fetch each medium photo into memory, embed it
//      exactly as Lifer's gallery vectors are, append it to rows.jsonl.
//   4. Rewrite the PRVE file and its provenance table from rows.jsonl.
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { setPriority } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync, createGzip } from "node:zlib";
import { parseArgs } from "node:util";
import duckdb from "duckdb";
import sharp from "sharp";
import { EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";
import { httpFetch } from "@lifer/core/lib/http.js";
import { computeEmbedding } from "@lifer/core/species/embeddings.js";
import { isOpenVectorLicense } from "@lifer/core/species/licensePolicy.js";
import { pool } from "../db.js";
import { closeClip, prepareClip } from "../lib/clipEmbedding.js";
import { OPEN_VECTORS_MAX } from "../pipeline/openVectors.js";
import {
  attributionText,
  decodePrve,
  encodePrveHeader,
  encodePrveRow,
  mapTaxaToSpecies,
  needsWork,
  parseLine,
  parseState,
  prveLicenseCode,
  rankCandidates,
  vectorToBase64,
  type Candidate,
  type LiferSpecies,
  type StateLine,
} from "../pipeline/openVectorSource.js";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "open-vectors");
const INAT_DIR = path.join(OUT_DIR, "inat");
const ROWS = path.join(OUT_DIR, "rows.jsonl");
const LOG = path.join(OUT_DIR, "run.log");
const CANDIDATES = path.join(OUT_DIR, "candidates.parquet");
const PRVE_FILE = path.join(OUT_DIR, `lifer-open-vectors-${EMBEDDING_MODEL_VERSION}.prve.gz`);
const PROVENANCE_FILE = path.join(OUT_DIR, `lifer-open-vectors-${EMBEDDING_MODEL_VERSION}-provenance.tsv`);
const BUCKET = "https://inaturalist-open-data.s3.amazonaws.com";
const METADATA = ["taxa", "observers", "observations", "photos"] as const;
const DIMENSION = 768;
// The S3 bucket is built for bulk reads; this keeps the job a small, steady client.
const PHOTO_PACE_MS = 150;
const PHOTO_CONCURRENCY = 3;

// Birds first, then the rest; groups are Lifer's taxon_class values.
const GROUP_ORDER = [
  "aves",
  "mammalia",
  "squamata",
  "testudines",
  "amphibia",
  "actinopterygii",
  "cephalopoda",
  "nudibranchs",
  "corals",
  "jellies_and_anemones",
  "echinodermata",
  "crustacea",
  "marine_mollusks",
  "sponges_tunicates_other",
];
const GROUP_ALIASES: Record<string, string[]> = {
  birds: ["aves"],
  mammals: ["mammalia"],
  reptiles: ["squamata", "testudines"],
  amphibians: ["amphibia"],
  fish: ["actinopterygii"],
};

function log(message: string) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
}

// ---- 1. metadata ---------------------------------------------------------------------------

/** S3's ETag: the MD5 of the file, or for a multipart upload the MD5 of its parts' MD5s plus
 *  "-<parts>". The part size isn't published, so every common size giving that part count is tried. */
async function matchesEtag(file: string, size: number, etag: string): Promise<boolean | null> {
  const [hex, partsText] = etag.split("-");
  if (!partsText) {
    const h = createHash("md5");
    await pipeline(createReadStream(file), h);
    return h.digest("hex") === hex;
  }
  const parts = Number(partsText);
  const MiB = 1024 * 1024;
  const sizes = [8, 16, 32, 64, 100, 128, 256, 500, 512, 1000, 1024].map((m) => m * MiB).filter((p) => Math.ceil(size / p) === parts);
  if (!sizes.length) return null;
  const runs = sizes.map((partSize) => ({ partSize, done: [] as Buffer[], h: createHash("md5"), inPart: 0 }));
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * MiB }) as AsyncIterable<Buffer>) {
    for (const r of runs) {
      let off = 0;
      while (off < chunk.length) {
        const take = Math.min(chunk.length - off, r.partSize - r.inPart);
        r.h.update(chunk.subarray(off, off + take));
        r.inPart += take;
        off += take;
        if (r.inPart === r.partSize) {
          r.done.push(r.h.digest());
          r.h = createHash("md5");
          r.inPart = 0;
        }
      }
    }
  }
  return runs.some((r) => {
    if (r.inPart > 0) r.done.push(r.h.digest());
    return createHash("md5").update(Buffer.concat(r.done)).digest("hex") === hex;
  });
}

async function downloadMetadata(name: string, refresh: boolean): Promise<string> {
  const dest = path.join(INAT_DIR, `${name}.csv.gz`);
  // A verified file is kept until --refresh-metadata, so a resume never pulls a newer dump.
  if (existsSync(dest) && !refresh) return dest;
  const url = `${BUCKET}/${name}.csv.gz`;
  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) throw new Error(`${url}: HTTP ${head.status}`);
  const etag = (head.headers.get("etag") ?? "").replaceAll('"', "");
  const size = Number(head.headers.get("content-length"));
  if (existsSync(dest) && existsSync(`${dest}.etag`) && readFileSync(`${dest}.etag`, "utf8") === etag) return dest;
  const part = `${dest}.part`;
  // A part file from an older dump can't be continued.
  if (existsSync(`${part}.etag`) && readFileSync(`${part}.etag`, "utf8") !== etag) rmSync(part, { force: true });
  writeFileSync(`${part}.etag`, etag);
  for (let attempt = 0; ; attempt++) {
    const have = existsSync(part) ? statSync(part).size : 0;
    if (have >= size) break;
    log(`metadata: ${name} ${(have / 1e9).toFixed(1)} of ${(size / 1e9).toFixed(1)} GB`);
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${have}-` } });
      if (res.status !== 206 && !(res.status === 200 && have === 0)) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part, { flags: "a" }));
    } catch (err) {
      if (attempt >= 20) throw err;
      log(`metadata: ${name} interrupted (${(err as Error).message}), resuming`);
      await new Promise((r) => setTimeout(r, Math.min(60_000, 2000 * 2 ** attempt)));
    }
  }
  log(`metadata: checking ${name} against its ETag`);
  const verified = statSync(part).size === size ? await matchesEtag(part, size, etag) : false;
  if (verified === false) {
    rmSync(part);
    throw new Error(`${name}.csv.gz failed its checksum; removed, rerun to download it again`);
  }
  if (verified === null) log(`metadata: ${name} has an ETag of unknown part size; kept on its byte count`);
  renameSync(part, dest);
  writeFileSync(`${dest}.etag`, etag);
  rmSync(`${part}.etag`, { force: true });
  return dest;
}

// ---- 2. candidate index --------------------------------------------------------------------

function duck(file: string) {
  const db = new duckdb.Database(file);
  const run = (sql: string) => new Promise<void>((ok, fail) => db.exec(sql, (e) => (e ? fail(e) : ok())));
  const all = <T>(sql: string) =>
    new Promise<T[]>((ok, fail) => db.all(sql, (e: Error | null, rows: unknown[]) => (e ? fail(e) : ok(rows as T[]))));
  const close = () => new Promise<void>((ok) => db.close(() => ok()));
  return { run, all, close };
}

const tsv = (file: string, columns: string) =>
  `read_csv('${file}', delim='\t', header=true, quote='', escape='', ignore_errors=true, columns={${columns}})`;

async function buildIndex(files: Record<string, string>): Promise<void> {
  if (existsSync(CANDIDATES)) return;
  log("index: building the candidate index (one-time, a few minutes)");
  const dbFile = path.join(OUT_DIR, "index.duckdb");
  const db = duck(dbFile);
  // Each table survives a crash, so a rerun continues at the first missing one.
  await db.run(`
    SET memory_limit='6GB'; SET threads=4; SET preserve_insertion_order=false;
    SET temp_directory='${path.join(OUT_DIR, "duckdb-tmp")}';
    CREATE TABLE IF NOT EXISTS taxa AS SELECT * FROM ${tsv(files.taxa, "'taxon_id':'INTEGER','ancestry':'VARCHAR','rank_level':'DOUBLE','rank':'VARCHAR','name':'VARCHAR','active':'BOOLEAN'")};
    CREATE TABLE IF NOT EXISTS species_of AS
      SELECT taxon_id, taxon_id AS species_id FROM taxa WHERE rank = 'species' AND active AND ancestry LIKE '48460/1/%'
      UNION ALL
      SELECT t.taxon_id, a.taxon_id FROM (
        SELECT taxon_id, unnest(string_split(ancestry, '/'))::INTEGER AS aid FROM taxa
        WHERE rank_level < 10 AND active AND ancestry LIKE '48460/1/%') t
      JOIN taxa a ON a.taxon_id = t.aid AND a.rank = 'species' AND a.active;
  `);
  log("index: open-licence photos");
  await db.run(`CREATE TABLE IF NOT EXISTS open_photos AS
    SELECT photo_id, observation_uuid, extension, upper(license) AS license, position
    FROM ${tsv(files.photos, "'photo_uuid':'VARCHAR','photo_id':'INTEGER','observation_uuid':'UUID','observer_id':'INTEGER','extension':'VARCHAR','license':'VARCHAR','width':'INTEGER','height':'INTEGER','position':'INTEGER'")}
    WHERE upper(license) IN ('CC0', 'CC-BY', 'PD') AND greatest(width, height) >= 500 AND least(width, height) >= 250;`);
  log("index: research-grade observations");
  await db.run(`CREATE TABLE IF NOT EXISTS obs AS
    SELECT o.observation_uuid, o.observer_id, o.latitude, o.longitude, o.observed_on, s.species_id
    FROM ${tsv(files.observations, "'observation_uuid':'UUID','observer_id':'INTEGER','latitude':'DOUBLE','longitude':'DOUBLE','positional_accuracy':'DOUBLE','taxon_id':'INTEGER','quality_grade':'VARCHAR','observed_on':'VARCHAR','anomaly_score':'DOUBLE'")} o
    JOIN species_of s ON s.taxon_id = o.taxon_id
    WHERE o.quality_grade = 'research';`);
  log("index: picking candidates");
  await db.run(`
    CREATE TABLE IF NOT EXISTS observers AS SELECT * FROM ${tsv(files.observers, "'observer_id':'INTEGER','login':'VARCHAR','name':'VARCHAR'")};
    COPY (
      WITH j AS (
        SELECT o.species_id AS taxon_id, p.photo_id, p.extension, p.license, p.position,
               o.observer_id, o.latitude, o.longitude, o.observed_on
        FROM open_photos p JOIN obs o USING (observation_uuid)),
      r AS (SELECT *, row_number() OVER (PARTITION BY taxon_id, observer_id ORDER BY position, hash(photo_id)) AS k FROM j),
      s AS (SELECT * EXCLUDE (k), row_number() OVER (PARTITION BY taxon_id ORDER BY k, hash(photo_id)) AS n FROM r WHERE k <= 3)
      SELECT s.* EXCLUDE (n), t.name AS taxon_name, coalesce(nullif(trim(u.name), ''), u.login) AS photographer
      FROM s JOIN taxa t ON t.taxon_id = s.taxon_id LEFT JOIN observers u ON u.observer_id = s.observer_id
      WHERE n <= 80 ORDER BY s.taxon_id, n
    ) TO '${CANDIDATES}.tmp' (FORMAT parquet);`);
  await db.close();
  renameSync(`${CANDIDATES}.tmp`, CANDIDATES);
  rmSync(dbFile, { force: true });
  rmSync(`${dbFile}.wal`, { force: true });
  log("index: done");
}

// ---- 3. Lifer's species, read-only ---------------------------------------------------------

interface Species extends LiferSpecies {
  group: string;
  openVectors: number;
  /** iNaturalist photo ids already in Lifer's gallery. */
  liferPhotoIds: Set<number>;
}

async function loadSpecies(): Promise<Species[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const species = await client.query<{ scientific_name: string; inat_taxon_id: number | null; taxon_class: string; synonyms: string[] }>(
      `SELECT s.scientific_name, s.inat_taxon_id, s.taxon_class,
              coalesce(array_agg(ss.synonym_name) FILTER (WHERE ss.synonym_name IS NOT NULL), '{}') AS synonyms
       FROM species s LEFT JOIN species_synonyms ss ON ss.species_id = s.id
       WHERE NOT s.is_other_taxa GROUP BY s.id`,
    );
    const gallery = await client.query<{ scientific_name: string; photo_url: string; license: string; embedded: boolean }>(
      `SELECT s.scientific_name, p.photo_url, p.license, ge.reference_photo_id IS NOT NULL AS embedded
       FROM species_reference_photos p JOIN species s ON s.id = p.species_id
       LEFT JOIN species_reference_gallery_embeddings ge ON ge.reference_photo_id = p.id AND ge.model_version = $1`,
      [EMBEDDING_MODEL_VERSION],
    );
    await client.query("ROLLBACK");
    const byName = new Map<string, Species>();
    for (const r of species.rows)
      byName.set(r.scientific_name, {
        scientificName: r.scientific_name,
        inatTaxonId: r.inat_taxon_id,
        synonyms: r.synonyms,
        group: r.taxon_class,
        openVectors: 0,
        liferPhotoIds: new Set(),
      });
    for (const g of gallery.rows) {
      const s = byName.get(g.scientific_name);
      if (!s) continue;
      if (g.embedded && isOpenVectorLicense(g.license)) s.openVectors++;
      const id = /inaturalist[^/]*\/photos\/(\d+)\//.exec(g.photo_url)?.[1];
      if (id) s.liferPhotoIds.add(Number(id));
    }
    return [...byName.values()];
  } finally {
    client.release();
  }
}

// ---- 4. outputs ----------------------------------------------------------------------------

async function* photoLines(): AsyncGenerator<Extract<StateLine, { t: "photo" }>> {
  if (!existsSync(ROWS)) return;
  const seen = new Set<number>();
  for await (const raw of readline.createInterface({ input: createReadStream(ROWS) })) {
    const line = parseLine(raw);
    if (line?.t !== "photo" || seen.has(line.photoId)) continue;
    seen.add(line.photoId);
    yield line;
  }
}

/** Rewrites the PRVE file and its provenance table from rows.jsonl, then reads the file back. */
async function writeOutputs(): Promise<number> {
  let count = 0;
  for await (const _ of photoLines()) count++;
  const gz = createGzip();
  const done = pipeline(gz, createWriteStream(`${PRVE_FILE}.tmp`));
  const provenance = createWriteStream(`${PROVENANCE_FILE}.tmp`);
  provenance.write("row\tspecies\tinat_taxon_id\tinat_photo_id\tphotographer\tlicense\tattribution\tsource_url\tobserved_on\n");
  gz.write(encodePrveHeader(EMBEDDING_MODEL_VERSION, DIMENSION, count));
  let row = 0;
  const clean = (s: string | number | null) => String(s ?? "").replace(/[\t\n]/g, " ");
  for await (const p of photoLines()) {
    const code = prveLicenseCode(p.license);
    if (code === null) throw new Error(`rows.jsonl holds photo ${p.photoId} with closed licence ${p.license}`);
    const chunk = encodePrveRow(
      { species: p.species, licenseCode: code, photographer: p.photographer, sourceUrl: p.sourceUrl, vector: Buffer.from(p.v, "base64") },
      DIMENSION,
    );
    if (!gz.write(chunk)) await new Promise((r) => gz.once("drain", r));
    provenance.write(
      [row++, p.species, p.taxonId, p.photoId, p.photographer, p.license, p.attribution, p.sourceUrl, p.observedOn].map(clean).join("\t") + "\n",
    );
  }
  gz.end();
  await done;
  await new Promise((r) => provenance.end(r));
  // shortcut: reads the whole file back into memory (about 1.6 KB per row); stream it past ~1M rows.
  const back = decodePrve(gunzipSync(readFileSync(`${PRVE_FILE}.tmp`)));
  if (back.rows.length !== count || back.dimension !== DIMENSION || back.modelVersion !== EMBEDDING_MODEL_VERSION)
    throw new Error("the PRVE file did not read back as written");
  renameSync(`${PRVE_FILE}.tmp`, PRVE_FILE);
  renameSync(`${PROVENANCE_FILE}.tmp`, PROVENANCE_FILE);
  return count;
}

// ---- the job -------------------------------------------------------------------------------

/** The medium photo, re-encoded the way Lifer stores gallery photos before embedding them
 *  (uploads/image.ts generateReferenceDerivatives: rotate, at most 1200 px wide, WebP 82). */
export async function embedPhoto(image: Buffer): Promise<number[]> {
  const display = await sharp(image).rotate().resize({ width: 1200, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  const v = await computeEmbedding(display);
  if (v.length !== DIMENSION) throw new Error(`CLIP gave ${v.length} values, not ${DIMENSION}`);
  return v;
}

class PermanentError extends Error {}

async function fetchPhoto(c: Candidate): Promise<Buffer> {
  const res = await httpFetch(`${BUCKET}/photos/${c.photoId}/medium.${c.extension}`, {
    paceMs: PHOTO_PACE_MS,
    maxRetries: 4,
    retryServerErrors: true,
    timeoutMs: 60_000,
  });
  if (res.status === 403 || res.status === 404) throw new PermanentError(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new PermanentError(`only ${buf.length} bytes`);
  return buf;
}

function duration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  return h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${h} h ${Math.round((ms % 3_600_000) / 60_000)} min` : `${Math.round(ms / 60_000)} min`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      taxa: { type: "string" },
      "per-species": { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "refresh-metadata": { type: "boolean", default: false },
    },
  });
  const perSpecies = Number(values["per-species"] ?? OPEN_VECTORS_MAX);
  const limit = values.limit ? Number(values.limit) : Infinity;
  if (!(perSpecies >= 1) || !(limit >= 1)) throw new Error("--per-species and --limit take a positive number");
  const dryRun = values["dry-run"]!;
  // Background work: never slow Lifer or anything else the person is using.
  try {
    setPriority(19);
  } catch {
    // Already started at low priority (nice); raising it back isn't allowed, nor needed.
  }
  mkdirSync(INAT_DIR, { recursive: true });
  log(`start: ${process.argv.slice(2).join(" ") || "(all groups)"}; model ${EMBEDDING_MODEL_VERSION}; ${perSpecies} per species`);

  const files = {} as Record<string, string>;
  for (const name of METADATA) files[name] = await downloadMetadata(name, values["refresh-metadata"]!);
  await buildIndex(files);

  const species = await loadSpecies();
  await pool.end();
  const groups = new Set(species.map((s) => s.group));
  const order = [...GROUP_ORDER.filter((g) => groups.has(g)), ...[...groups].filter((g) => !GROUP_ORDER.includes(g)).sort()];
  const wanted = values.taxa
    ? values.taxa.split(",").flatMap((t) => {
        const key = t.trim().toLowerCase();
        const hit = GROUP_ALIASES[key] ?? (groups.has(key) ? [key] : null);
        if (!hit) throw new Error(`Unknown --taxa "${t}"; use ${[...Object.keys(GROUP_ALIASES), ...order].join(", ")}`);
        return hit;
      })
    : order;
  const selected = species
    .filter((s) => wanted.includes(s.group))
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.scientificName.localeCompare(b.scientificName));

  const db = duck(":memory:");
  const taxa = await db.all<{ taxon_id: number; taxon_name: string }>(`SELECT DISTINCT taxon_id, taxon_name FROM '${CANDIDATES}'`);
  const taxonToSpecies = mapTaxaToSpecies(species, taxa.map((t) => ({ taxonId: t.taxon_id, name: t.taxon_name })));
  const taxaOf = new Map<string, number[]>();
  for (const [taxonId, name] of taxonToSpecies) taxaOf.set(name, [...(taxaOf.get(name) ?? []), taxonId]);

  const state = parseState(existsSync(ROWS) ? readFileSync(ROWS, "utf8") : "");
  const open = selected.filter((s) => needsWork(state, s.scientificName, s.openVectors, perSpecies, taxaOf.has(s.scientificName)));
  const todo = open.slice(0, limit);
  const doneBefore = selected.length - open.length;
  log(
    `species: ${selected.length} in ${wanted.join(", ")}; ${doneBefore} done before; ${todo.length} this run; ` +
      `${selected.filter((s) => taxaOf.has(s.scientificName)).length} have open iNaturalist photos`,
  );
  const append = (line: StateLine) => {
    if (!dryRun) appendFileSync(ROWS, JSON.stringify(line) + "\n");
  };

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      log(`${sig}: finishing the current species, then writing the files`);
      stopping = true;
    });
  if (!dryRun) await prepareClip();

  const started = Date.now();
  let speciesDone = 0;
  let photos = 0;
  let lastLog = 0;
  const BATCH = 200;
  for (let b = 0; b < todo.length && !stopping; b += BATCH) {
    const batch = todo.slice(b, b + BATCH);
    const ids = batch.flatMap((s) => taxaOf.get(s.scientificName) ?? []);
    const rows = ids.length
      ? await db.all<{ taxon_id: number; photo_id: number; extension: string; license: string; position: number; observer_id: number; latitude: number | null; longitude: number | null; observed_on: string | null; photographer: string | null }>(
          `SELECT * FROM '${CANDIDATES}' WHERE taxon_id IN (${ids.join(",")})`,
        )
      : [];
    const byTaxon = new Map<number, typeof rows>();
    for (const r of rows) byTaxon.set(r.taxon_id, [...(byTaxon.get(r.taxon_id) ?? []), r]);

    for (const s of batch) {
      if (stopping) break;
      const name = s.scientificName;
      let have = (state.have.get(name) ?? 0) + s.openVectors;
      const haveBefore = have;
      const cands = (taxaOf.get(name) ?? []).flatMap((t) => byTaxon.get(t) ?? []);
      const info = new Map(cands.map((c) => [c.photo_id, c]));
      const ranked = rankCandidates(
        cands.map((c) => ({
          photoId: c.photo_id,
          extension: c.extension,
          license: c.license,
          observerId: c.observer_id,
          position: c.position,
          latitude: c.latitude,
          longitude: c.longitude,
          observedOn: c.observed_on,
        })),
        new Set(cands.map((c) => c.photo_id).filter((id) => state.tried.has(id) || s.liferPhotoIds.has(id))),
      );
      if (dryRun) {
        const picks = ranked.slice(0, Math.max(0, perSpecies - have));
        log(`dry run: ${name}: ${s.openVectors} open in Lifer, ${cands.length} candidates, picks ${picks.map((p) => `${p.photoId} (${p.license}, observer ${p.observerId}, ${p.observedOn})`).join("; ") || "none"}`);
      } else {
        let next = 0;
        // A few attempts past the target, so a run of missing photos can't stall on one species.
        const maxAttempts = perSpecies * 2 + 4;
        while (have < perSpecies && next < ranked.length && next < maxAttempts && !stopping) {
          const wave = ranked.slice(next, next + Math.min(PHOTO_CONCURRENCY, perSpecies - have));
          next += wave.length;
          const images = await Promise.allSettled(wave.map(fetchPhoto));
          for (let i = 0; i < wave.length; i++) {
            const c = wave[i];
            const got = images[i];
            try {
              if (got.status === "rejected") throw got.reason;
              const vector = await embedPhoto(got.value);
              const meta = info.get(c.photoId)!;
              const photographer = meta.photographer ?? `iNaturalist user ${c.observerId}`;
              append({
                t: "photo",
                species: name,
                taxonId: meta.taxon_id,
                photoId: c.photoId,
                photographer,
                license: c.license,
                attribution: attributionText(photographer, c.license),
                sourceUrl: `https://www.inaturalist.org/photos/${c.photoId}`,
                photoUrl: `${BUCKET}/photos/${c.photoId}/medium.${c.extension}`,
                observedOn: c.observedOn,
                latitude: c.latitude,
                longitude: c.longitude,
                v: vectorToBase64(vector),
              });
              state.tried.add(c.photoId);
              have++;
              photos++;
            } catch (err) {
              // Missing or unreadable photos are recorded; network trouble is retried next run.
              const permanent = err instanceof PermanentError || /unsupported image|Input buffer/i.test((err as Error).message);
              if (permanent) append({ t: "failed", species: name, photoId: c.photoId, reason: (err as Error).message });
              else log(`warn: ${name} photo ${c.photoId}: ${(err as Error).message}`);
            }
          }
        }
        if (stopping && have < perSpecies && next < ranked.length) break;
        // A reopened species that found nothing new adds no line.
        if (!state.done.has(name) || have > haveBefore) append({ t: "done", species: name, photos: have - s.openVectors });
      }
      speciesDone++;
      if (Date.now() - lastLog > 60_000 || speciesDone === todo.length) {
        lastLog = Date.now();
        const elapsed = Date.now() - started;
        const eta = (elapsed / speciesDone) * (todo.length - speciesDone);
        log(
          `progress: ${doneBefore + speciesDone}/${selected.length} species (${s.group}), ${photos} photos this run, ` +
            `${(photos / (elapsed / 1000)).toFixed(2)} photos/s, ETA ${duration(eta)}`,
        );
      }
    }
  }
  await db.close();
  if (!dryRun) {
    const rowsWritten = await writeOutputs();
    log(`files: ${rowsWritten} vectors in ${path.basename(PRVE_FILE)}, credits in ${path.basename(PROVENANCE_FILE)}`);
  }
  log(`end: ${speciesDone} species, ${photos} photos in ${duration(Date.now() - started)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main()
    .catch((err) => {
      log(`FAILED: ${(err as Error).stack ?? err}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeClip();
      await pool.end().catch(() => {});
    });
