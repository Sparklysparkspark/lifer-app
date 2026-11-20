// Species-matching quality per taxon class, on the catalog's own gallery photos: each sampled
// photo goes through the import path (animal detector, subject crop and whole frame, identification
// model) and is ranked by the production ranking against every
// species but with its own photo (and near copies of it) left out of its species' references.
// Reads the database only.
//
//   npm run benchmark-matching -w data-pipeline                       300 species per class
//   npm run benchmark-matching -w data-pipeline -- --per-class=50     a quicker run
//   npm run benchmark-matching -w data-pipeline -- --detector=basic   the bundled fallback detector
//   npm run benchmark-matching -w data-pipeline -- --label=after      names the report files
//
// Ranking experiments rerun from the cached vectors: --text-weight=0.5, --vectors=crop|unsure|mean
// (default "real", as the app: the crop and the whole frame; "unsure" adds the frame only when the
// detector is unsure),
// --group=pool,temperature,share (the genus/family fallback), --views=regional.
// Diagnosis (why a class is weak): --vectors=whole|centre (the whole frame, or its middle 60%,
// instead of the detector's crop), --model=clip (rank with CLIP instead), --ensemble (sweep
// BioCLIP/CLIP weights), --portraits-only (leave reference photos that aren't of the animal out),
// --references (vectors per species, non-portraits and near copies per class).
// --clip-per-class=N limits the CLIP runs to the first N sampled photos per class.
// --cached-only scores just the photos already run (a look at a run still in progress).
// --small: each photo shrunk to the middle of a canvas 4x its size, over a blurred copy of itself,
// so the animal fills about 6% of the frame, as in a field photo (what the detector is for).
// --limit-per-class=N runs and scores only the first N sampled photos per class.
// --queries=file.json: photos from outside the catalog instead of sampled gallery photos, as
// [{ species, scientific, genus, family, cls, photo, display }] (photo: a unique key, display: a
// path). Each species keeps all its references except near copies of the photo, and a species
// with none can't be found, so galleries can be compared before and after they change.
//
// Rerun the same command to resume: the catalog vectors and every photo's vectors are cached in
// --cache (per detector), so only photos not yet run are embedded. Writes <label>.json and
// <label>.md next to --out.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { idModel } from "@lifer/core/species/idModel.js";
// Registers the downloaded animal detector, which --detector=auto uses when it's there.
import "@lifer/core/species/detectorModel.js";
import { activeDetectorPath, BASIC_DETECTOR_MODEL_PATH } from "@lifer/core/species/inference.js";
import { handleRequest, type AnalyzeResult, type EmbedTarget } from "@lifer/core/species/inferenceWorker.js";
import {
  RANKING_DEFAULTS,
  rankCandidates,
  type CandidateEntry,
  type RankingTuning,
  type SpeciesVectors,
} from "@lifer/core/species/suggest.js";
import { l2Normalize } from "@lifer/core/species/inferenceWorker.js";
import { classifyReferencePhoto, PORTRAIT } from "@lifer/core/species/referencePortrait.js";
import { clipModel } from "@lifer/core/species/clipModel.js";
import { CLIP_SPACE } from "@lifer/core/species/vectorSpaces.js";
import sharp from "sharp";
import { monthlyFromWeekly } from "@lifer/core/species/seasonality.js";
import { ID_SPACE } from "@lifer/core/species/vectorSpaces.js";
import { pool } from "../db.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const { values: args } = parseArgs({
  options: {
    "per-class": { type: "string", default: "300" },
    detector: { type: "string", default: "auto" },
    label: { type: "string", default: "report" },
    seed: { type: "string", default: "1" },
    region: { type: "string", default: "BLZ" },
    cache: { type: "string", default: path.join(REPO_ROOT, "data", "matching-benchmark") },
    out: { type: "string", default: path.join(REPO_ROOT, "docs", "plans", "assets", "matching-quality") },
    "text-weight": { type: "string" },
    vectors: { type: "string", default: "real" },
    group: { type: "string" },
    views: { type: "string", default: "regional,global" },
    model: { type: "string", default: "bioclip" },
    ensemble: { type: "boolean", default: false },
    "portraits-only": { type: "boolean", default: false },
    references: { type: "boolean", default: false },
    "clip-per-class": { type: "string", default: "100" },
    "cached-only": { type: "boolean", default: false },
    small: { type: "boolean", default: false },
    "limit-per-class": { type: "string" },
    queries: { type: "string" },
  },
});
const PER_CLASS = Number(args["per-class"]);
const SPACE = args["text-weight"] ? { ...ID_SPACE, textWeight: Number(args["text-weight"]) } : ID_SPACE;
const [groupPool, groupTemperature, groupShareMin] = (args.group ?? "").split(",").map(Number);
const TUNING: RankingTuning = args.group ? { groupPool, groupTemperature, groupShareMin } : RANKING_DEFAULTS;
const DIM = 768;
// A reference vector this close to the query photo's own is the same picture (a reference photo
// that is also in the gallery, a re-upload), so it's left out with it.
const SAME_PHOTO = 0.95;

const detectorPath =
  args.detector === "basic"
    ? BASIC_DETECTOR_MODEL_PATH
    : args.detector === "auto"
      ? activeDetectorPath()
      : args.detector!;
const detectorKey = path.basename(detectorPath, ".onnx") + (args.small ? "-small" : "");
mkdirSync(args.cache!, { recursive: true });
mkdirSync(args.out!, { recursive: true });

// ---------------------------------------------------------------------------------------------
// Seeded randomness, so the same command samples the same photos.
// ---------------------------------------------------------------------------------------------
let seed = Number(args.seed) >>> 0 || 1;
function random(): number {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function shuffle<T>(xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

// ---------------------------------------------------------------------------------------------
// Catalog vectors (identification model), cached as one binary file.
// ---------------------------------------------------------------------------------------------
interface CatalogSpecies {
  id: string;
  common: string | null;
  scientific: string;
  genus: string;
  family: string | null;
  cls: string;
  /** Offsets (in vectors) into the binary file; -1 for none. */
  ref: number;
  text: number;
  gallery: Array<{ photo: string; at: number; display: string | null }>;
}

async function loadCatalog(): Promise<{ species: CatalogSpecies[]; data: Float32Array }> {
  const meta = path.join(args.cache!, "catalog.json");
  const bin = path.join(args.cache!, "catalog.bin");
  if (existsSync(meta) && existsSync(bin)) {
    const buf = readFileSync(bin);
    return {
      species: JSON.parse(readFileSync(meta, "utf8")),
      data: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
    };
  }
  console.log("Reading the catalog's identification vectors (once; cached)...");
  const ids = (
    await pool.query<{ id: string }>(
      `SELECT s.id FROM species s
        WHERE (s.reference_display_path IS NOT NULL OR s.reference_photo IS NOT NULL)
          AND (EXISTS (SELECT 1 FROM id_model_reference_embeddings r WHERE r.species_id = s.id AND r.model_version = $1)
            OR EXISTS (SELECT 1 FROM id_model_gallery_embeddings g WHERE g.species_id = s.id AND g.model_version = $1))
        ORDER BY s.id`,
      [ID_SPACE.modelVersion],
    )
  ).rows.map((r) => r.id);
  const chunks: Float32Array[] = [];
  let count = 0;
  const push = (v: number[] | null) => {
    if (!v) return -1;
    chunks.push(Float32Array.from(v));
    return count++;
  };
  const species: CatalogSpecies[] = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const res = await pool.query<{
      id: string;
      common_name: string | null;
      scientific_name: string;
      genus: string;
      family: string | null;
      taxon_class: string;
      ref: number[] | null;
      text: number[] | null;
      gallery: Array<{ photo: string; display: string | null; v: number[] }> | null;
    }>(
      `SELECT s.id, s.common_name, s.scientific_name, s.genus, s.family, s.taxon_class,
              r.embedding AS ref, t.embedding AS text,
              (SELECT json_agg(json_build_object('photo', g.reference_photo_id, 'display', p.display_path, 'v', g.embedding))
                 FROM id_model_gallery_embeddings g JOIN species_reference_photos p ON p.id = g.reference_photo_id
                WHERE g.species_id = s.id AND g.model_version = $1) AS gallery
         FROM species s
         LEFT JOIN id_model_reference_embeddings r ON r.species_id = s.id AND r.model_version = $1
         LEFT JOIN id_model_text_embeddings t ON t.species_id = s.id AND t.model_version = $1
        WHERE s.id = ANY($2::uuid[])`,
      [ID_SPACE.modelVersion, ids.slice(i, i + 1000)],
    );
    for (const r of res.rows)
      species.push({
        id: r.id,
        common: r.common_name,
        scientific: r.scientific_name,
        genus: r.genus,
        family: r.family,
        cls: r.taxon_class,
        ref: push(r.ref),
        text: push(r.text),
        gallery: (r.gallery ?? []).map((g) => ({ photo: g.photo, display: g.display, at: push(g.v) })),
      });
    process.stdout.write(`\r  ${Math.min(i + 1000, ids.length)}/${ids.length} species`);
  }
  console.log();
  const data = new Float32Array(count * DIM);
  chunks.forEach((c, i) => data.set(c, i * DIM));
  writeFileSync(bin, Buffer.from(data.buffer));
  writeFileSync(meta, JSON.stringify(species));
  return { species, data };
}

/** The same species' CLIP vectors, by reference photo, for --model=clip, --ensemble and the
 *  portrait check (which reads CLIP vectors). */
interface ClipSpecies {
  ref: number;
  text: number;
  gallery: Record<string, number>;
}

async function loadClipCatalog(
  species: CatalogSpecies[],
): Promise<{ clip: Map<string, ClipSpecies>; data: Float32Array }> {
  const meta = path.join(args.cache!, "catalog-clip.json");
  const bin = path.join(args.cache!, "catalog-clip.bin");
  if (existsSync(meta) && existsSync(bin)) {
    const buf = readFileSync(bin);
    return {
      clip: new Map(Object.entries(JSON.parse(readFileSync(meta, "utf8")))),
      data: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
    };
  }
  console.log("Reading the catalog's CLIP vectors (once; cached)...");
  const chunks: Float32Array[] = [];
  let count = 0;
  const push = (v: number[] | null) => {
    if (!v) return -1;
    chunks.push(Float32Array.from(v));
    return count++;
  };
  const clip = new Map<string, ClipSpecies>();
  const ids = species.map((s) => s.id);
  for (let i = 0; i < ids.length; i += 1000) {
    const res = await pool.query<{
      id: string;
      ref: number[] | null;
      text: number[] | null;
      gallery: Array<{ photo: string; v: number[] }> | null;
    }>(
      `SELECT s.id, r.embedding AS ref, t.embedding AS text,
              (SELECT json_agg(json_build_object('photo', g.reference_photo_id, 'v', g.embedding))
                 FROM species_reference_gallery_embeddings g WHERE g.species_id = s.id AND g.model_version = $1) AS gallery
         FROM species s
         LEFT JOIN species_reference_embeddings r ON r.species_id = s.id AND r.model_version = $1
         LEFT JOIN species_text_embeddings t ON t.species_id = s.id AND t.model_version = $2
        WHERE s.id = ANY($3::uuid[])`,
      [CLIP_SPACE.modelVersion, CLIP_SPACE.textModelVersion, ids.slice(i, i + 1000)],
    );
    for (const r of res.rows)
      clip.set(r.id, {
        ref: push(r.ref),
        text: push(r.text),
        gallery: Object.fromEntries((r.gallery ?? []).map((g) => [g.photo, push(g.v)])),
      });
    process.stdout.write(`\r  ${Math.min(i + 1000, ids.length)}/${ids.length} species`);
  }
  console.log();
  const data = new Float32Array(count * DIM);
  chunks.forEach((c, i) => data.set(c, i * DIM));
  writeFileSync(bin, Buffer.from(data.buffer));
  writeFileSync(meta, JSON.stringify(Object.fromEntries(clip)));
  return { clip, data };
}

// ---------------------------------------------------------------------------------------------
// Sampling: per class, species with a gallery photo on disk and another picture of it left over.
// ---------------------------------------------------------------------------------------------
interface Query {
  species: CatalogSpecies;
  photo: string;
  display: string;
  /** Vector offsets of the species' references that stay in (not the photo, not copies of it). */
  keep: number[];
}

const vec = (data: Float32Array, at: number) => data.subarray(at * DIM, at * DIM + DIM);
const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i] * b[i];
  return s;
};

function sample(species: CatalogSpecies[], data: Float32Array): Query[] {
  const byClass = new Map<string, CatalogSpecies[]>();
  for (const s of species) byClass.set(s.cls, [...(byClass.get(s.cls) ?? []), s]);
  const queries: Query[] = [];
  for (const cls of [...byClass.keys()].sort()) {
    let taken = 0;
    for (const s of shuffle([...byClass.get(cls)!])) {
      if (taken >= PER_CLASS) break;
      const onDisk = s.gallery.filter((g) => g.display && existsSync(g.display));
      if (onDisk.length === 0) continue;
      const pick = onDisk[Math.floor(random() * onDisk.length)];
      const own = vec(data, pick.at);
      const keep = [s.ref, ...s.gallery.map((g) => g.at)].filter(
        (at) => at >= 0 && dot(vec(data, at), own) < SAME_PHOTO,
      );
      if (keep.length === 0) continue;
      queries.push({ species: s, photo: pick.photo, display: pick.display!, keep });
      taken++;
    }
  }
  return queries;
}

/** --queries: a species missing from the catalog (no vectors) stands in with none, so it's never found. */
function outsideQueries(file: string, byId: Map<string, CatalogSpecies>): Query[] {
  const rows: Array<{
    species: string;
    scientific: string;
    genus: string;
    family: string | null;
    cls: string;
    photo: string;
    display: string;
  }> = JSON.parse(readFileSync(file, "utf8"));
  return rows.map((r) => {
    if (!byId.has(r.species))
      byId.set(r.species, {
        id: r.species,
        common: null,
        scientific: r.scientific,
        genus: r.genus,
        family: r.family,
        cls: r.cls,
        ref: -1,
        text: -1,
        gallery: [],
      });
    const s = byId.get(r.species)!;
    return {
      species: s,
      photo: r.photo,
      display: r.display,
      keep: [s.ref, ...s.gallery.map((g) => g.at)].filter((at) => at >= 0),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Per-photo vectors through the import path, cached per detector.
// ---------------------------------------------------------------------------------------------
interface PhotoRun {
  photo: string;
  crop: string;
  whole: string;
  unsure: boolean;
  box: [number, number, number, number] | null;
  confidence: number;
  animal: number;
  detectMs: number;
  embedMs: number;
}
const b64 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
const unb64 = (s: string) => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const hooks = { runStarted() {}, runEnded() {} };

function readRuns(file: string): Map<string, PhotoRun> {
  const out = new Map<string, PhotoRun>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n"))
    if (line) out.set(JSON.parse(line).photo, JSON.parse(line));
  return out;
}

let peakRss = 0;
async function runPhotos(queries: Query[]): Promise<Map<string, PhotoRun>> {
  const file = path.join(args.cache!, `photos-${detectorKey}.jsonl`);
  const runs = readRuns(file);
  const target = (crop: boolean): EmbedTarget => ({ modelPath: idModel.path, missingMessage: "no model", crop });
  const todo = args["cached-only"] ? [] : queries.filter((q) => !runs.has(q.photo));
  console.log(`${runs.size} photos cached for ${detectorKey}, ${todo.length} to run`);
  let done = 0;
  for (const q of todo) {
    const base = {
      op: "analyze" as const,
      image: { path: args.small ? await smallSubject(q) : q.display },
      key: `${detectorKey}:${q.photo}`,
      detectorPath,
      cardCrop: false,
    };
    let t = performance.now();
    const det = (await handleRequest({ ...base, targets: [], presence: true, frame: true }, hooks)) as AnalyzeResult;
    const detectMs = performance.now() - t;
    t = performance.now();
    const emb = (await handleRequest(
      { ...base, targets: [target(true), target(false)], presence: false, subject: true },
      hooks,
    )) as AnalyzeResult;
    const embedMs = performance.now() - t;
    const [crop, whole] = emb.vectors;
    if (!(crop instanceof Float32Array) || !(whole instanceof Float32Array)) {
      console.warn(`\n  skipped ${q.display}: ${"error" in crop ? crop.error : ""}`);
      continue;
    }
    const run: PhotoRun = {
      photo: q.photo,
      crop: b64(crop),
      whole: b64(whole),
      unsure: emb.subjectUnsure ?? true,
      box: det.frame?.box ?? null,
      confidence: det.frame?.confidence ?? 0,
      animal: det.presence?.animal ?? 0,
      detectMs: Math.round(detectMs),
      embedMs: Math.round(embedMs),
    };
    appendFileSync(file, JSON.stringify(run) + "\n");
    runs.set(q.photo, run);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (++done % 25 === 0) process.stdout.write(`\r  ${done}/${todo.length} photos`);
  }
  if (todo.length) console.log();
  return runs;
}

/** The photo at a quarter of the width of a canvas filled with a blurred, enlarged copy of it
 *  (cached as a JPEG): a small subject in a wide frame. */
async function smallSubject(q: Query): Promise<string> {
  const file = path.join(args.cache!, "small", `${q.photo}.jpg`);
  if (existsSync(file)) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  const { width = 1, height = 1 } = await sharp(q.display).rotate().metadata();
  const photo = await sharp(q.display).rotate().toBuffer();
  const [w, h] = [width * 4, height * 4];
  await sharp(photo)
    .resize(w, h, { fit: "fill" })
    .blur(40)
    .composite([{ input: photo, left: Math.round((w - width) / 2), top: Math.round((h - height) / 2) }])
    .jpeg({ quality: 90 })
    .toFile(file);
  return file;
}

/** The middle 60% of each photo through the identification model (no detector): stands in for a
 *  well-placed crop when the detector finds nothing. Cached across detectors. */
async function runCentre(queries: Query[]): Promise<Map<string, PhotoRun>> {
  const file = path.join(args.cache!, "photos-centre.jsonl");
  const runs = readRuns(file);
  const todo = args["cached-only"] ? [] : queries.filter((q) => !runs.has(q.photo));
  console.log(`${runs.size} centre crops cached, ${todo.length} to run`);
  for (const q of todo) {
    const img = sharp(q.display).rotate();
    const { width = 0, height = 0 } = await img.metadata();
    const bytes = await sharp(q.display)
      .rotate()
      .extract({
        left: Math.round(width * 0.2),
        top: Math.round(height * 0.2),
        width: Math.round(width * 0.6),
        height: Math.round(height * 0.6),
      })
      .png()
      .toBuffer();
    const r = (await handleRequest(
      {
        op: "analyze",
        image: { bytes },
        key: null,
        targets: [{ modelPath: idModel.path, missingMessage: "no model", crop: false }],
        detectorPath,
        presence: false,
        cardCrop: false,
      },
      hooks,
    )) as AnalyzeResult;
    const v = r.vectors[0];
    if (!(v instanceof Float32Array)) continue;
    const run = {
      photo: q.photo,
      crop: b64(v),
      whole: b64(v),
      unsure: false,
      box: null,
      confidence: 0,
      animal: 0,
      detectMs: 0,
      embedMs: 0,
    };
    appendFileSync(file, JSON.stringify(run) + "\n");
    runs.set(q.photo, run);
  }
  return runs;
}

/** The detector's crop and the whole frame through CLIP, for the first --clip-per-class photos per class. */
async function runClip(queries: Query[]): Promise<Map<string, PhotoRun>> {
  const file = path.join(args.cache!, `photos-clip-${detectorKey}.jsonl`);
  const runs = readRuns(file);
  const todo = args["cached-only"] ? [] : queries.filter((q) => !runs.has(q.photo));
  console.log(`${runs.size} CLIP photos cached for ${detectorKey}, ${todo.length} to run`);
  const target = (crop: boolean): EmbedTarget => ({ modelPath: clipModel.path, missingMessage: "no CLIP model", crop });
  for (const q of todo) {
    const r = (await handleRequest(
      {
        op: "analyze",
        image: { path: q.display },
        key: `${detectorKey}:${q.photo}`,
        targets: [target(true), target(false)],
        detectorPath,
        presence: false,
        cardCrop: false,
        subject: true,
      },
      hooks,
    )) as AnalyzeResult;
    const [crop, whole] = r.vectors;
    if (!(crop instanceof Float32Array) || !(whole instanceof Float32Array)) continue;
    const run = {
      photo: q.photo,
      crop: b64(crop),
      whole: b64(whole),
      unsure: r.subjectUnsure ?? true,
      box: null,
      confidence: 0,
      animal: 0,
      detectMs: 0,
      embedMs: 0,
    };
    appendFileSync(file, JSON.stringify(run) + "\n");
    runs.set(q.photo, run);
  }
  return runs;
}

/** The first `n` sampled photos of each class (sampling order). */
function firstPerClass(queries: Query[], n: number): Query[] {
  const seen = new Map<string, number>();
  return queries.filter((q) => {
    const k = (seen.get(q.species.cls) ?? 0) + 1;
    seen.set(q.species.cls, k);
    return k <= n;
  });
}

// ---------------------------------------------------------------------------------------------
// Ranking and scoring
// ---------------------------------------------------------------------------------------------
interface Outcome {
  cls: string;
  family: string;
  rank: number | null;
  confident: boolean;
  unsure: boolean;
  found: boolean;
  /** Where the top pick went wrong: null when right. */
  miss: "class" | "family" | "genus" | "species" | null;
  top: string | null;
  /** The genus or family offered instead of an unsure species: whether it's the photo's. */
  group: "right" | "wrong" | null;
  /** The top pick is a bird though the photo isn't of one. */
  toBird: boolean;
}

// Offsets (in the identification catalog) of reference photos that aren't of the animal, for --portraits-only.
const nonPortrait = new Set<number>();

function speciesVectors(s: CatalogSpecies, data: Float32Array, keep?: number[]): SpeciesVectors {
  const all = keep ?? [s.ref, ...s.gallery.map((g) => g.at)].filter((at) => at >= 0);
  const portraits = all.filter((at) => !nonPortrait.has(at));
  // A species whose only photos aren't portraits keeps them rather than dropping out.
  const refs = args["portraits-only"] && portraits.length > 0 ? portraits : all;
  return {
    species_id: s.id,
    common_name: s.common,
    scientific_name: s.scientific,
    ref_embedding: null,
    gallery_embeddings: refs.map((at) => vec(data, at)),
    text_embedding: s.text >= 0 ? vec(data, s.text) : null,
    ref_license: null,
    gallery_licenses: null,
    genus: s.genus,
    family: s.family,
    taxon_class: s.cls,
  };
}

function score(
  queries: Query[],
  runs: Map<string, PhotoRun>,
  pools: { global: CandidateEntry[]; regional: CandidateEntry[] },
  byId: Map<string, CatalogSpecies>,
  ownVectors: (q: Query) => SpeciesVectors,
  view: "global" | "regional",
  space = SPACE,
): Outcome[] {
  const out: Outcome[] = [];
  for (const q of queries) {
    const run = runs.get(q.photo);
    if (!run) continue;
    const own: CandidateEntry = {
      species: ownVectors(q),
      is_vagrant: null,
      local_tier: null,
      seasonality: null,
    };
    const base = pools[view];
    const entries = base.map((e) => (e.species.species_id === q.species.id ? { ...e, species: own.species } : e));
    if (!entries.some((e) => e.species.species_id === q.species.id)) entries.push(own);
    const [crop, whole] = [unb64(run.crop), unb64(run.whole)];
    const vectors =
      args.vectors === "whole"
        ? [whole]
        : args.vectors === "crop" || args.vectors === "centre"
          ? [crop]
          : args.vectors === "mean"
            ? [l2Normalize(crop.map((v, i) => v + whole[i]))]
            : args.vectors === "unsure" && !run.unsure
              ? [crop]
              : [crop, whole];
    const ranked = rankCandidates(entries, new Map(), vectors, 10, null, space, null, false, TUNING);
    const at = ranked.findIndex((r) => r.id === q.species.id);
    const top = ranked[0] ? byId.get(ranked[0].id)! : null;
    const t = q.species;
    out.push({
      cls: t.cls,
      family: t.family ?? "?",
      rank: at >= 0 ? at + 1 : null,
      confident: !!ranked[0]?.confident,
      unsure: run.unsure,
      found: !!run.box && !run.unsure,
      miss:
        !top || at === 0
          ? null
          : top.cls !== t.cls
            ? "class"
            : top.family !== t.family
              ? "family"
              : top.genus !== t.genus
                ? "genus"
                : "species",
      top: top?.scientific ?? null,
      toBird: t.cls !== "aves" && top?.cls === "aves",
      group: (() => {
        const g = ranked[0]?.probably;
        if (!g) return null;
        return (g.rank === "genus" ? t.genus : t.family) === g.name ? "right" : "wrong";
      })(),
    });
  }
  return out;
}

const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);

function summarize(rows: Outcome[]) {
  const n = rows.length;
  const hit = (k: number) => pct(rows.filter((r) => r.rank != null && r.rank <= k).length, n);
  const confident = rows.filter((r) => r.confident);
  const misses = rows.filter((r) => r.miss);
  return {
    n,
    top1: hit(1),
    top5: hit(5),
    top10: hit(10),
    notConfident: pct(n - confident.length, n),
    confidentCorrect: pct(confident.filter((r) => r.rank === 1).length, confident.length),
    subjectFound: pct(rows.filter((r) => r.found).length, n),
    missWrongClass: pct(misses.filter((r) => r.miss === "class").length, n),
    missWrongFamily: pct(misses.filter((r) => r.miss === "family").length, n),
    missWrongGenus: pct(misses.filter((r) => r.miss === "genus").length, n),
    missSameGenus: pct(misses.filter((r) => r.miss === "species").length, n),
    groupOffered: pct(rows.filter((r) => r.group).length, n),
    groupRight: pct(rows.filter((r) => r.group === "right").length, rows.filter((r) => r.group).length),
    /** Neither a confident species nor a genus or family. */
    noAnswer: pct(rows.filter((r) => !r.confident && !r.group).length, n),
    toBird: pct(rows.filter((r) => r.toBird).length, rows.filter((r) => r.cls !== "aves").length),
  };
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
}

function table(title: string, groups: Array<[string, ReturnType<typeof summarize>]>): string {
  const head =
    "| Group | n | Top-1 | Top-5 | Top-10 | Not confident | Right when confident | Genus/family offered | Offered group right | No answer | Subject found | Wrong class | Wrong family | Wrong genus | Right genus, wrong species | Called a bird |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n";
  return (
    `### ${title}\n\n` +
    head +
    groups
      .map(
        ([g, s]) =>
          `| ${g} | ${s.n} | ${s.top1} | ${s.top5} | ${s.top10} | ${s.notConfident} | ${s.confidentCorrect} | ${s.groupOffered} | ${s.groupRight} | ${s.noAnswer} | ${s.subjectFound} | ${s.missWrongClass} | ${s.missWrongFamily} | ${s.missWrongGenus} | ${s.missSameGenus} | ${s.toBird} |`,
      )
      .join("\n") +
    "\n"
  );
}

/** Per class: reference vectors per species, how many aren't portraits, and near copies. */
function referenceStats(species: CatalogSpecies[], data: Float32Array): string {
  let md =
    "| Class | Species | Vectors per species (median) | Mean | Species with 1 to 3 | Not portraits | Near copies |\n|---|---|---|---|---|---|---|\n";
  for (const [cls, list] of [...groupBy(species, (s) => s.cls)].sort()) {
    const counts: number[] = [];
    let total = 0;
    let odd = 0;
    let copies = 0;
    for (const s of list) {
      const ats = [s.ref, ...s.gallery.map((g) => g.at)].filter((at) => at >= 0);
      counts.push(ats.length);
      total += ats.length;
      odd += ats.filter((at) => nonPortrait.has(at)).length;
      // A vector with an earlier near-identical one in the same species adds nothing.
      ats.forEach((at, i) => {
        if (ats.slice(0, i).some((b) => dot(vec(data, at), vec(data, b)) >= SAME_PHOTO)) copies++;
      });
    }
    counts.sort((a, b) => a - b);
    md += `| ${cls} | ${list.length} | ${counts[Math.floor(counts.length / 2)]} | ${(total / list.length).toFixed(1)} | ${pct(counts.filter((c) => c <= 3).length, list.length)} | ${pct(odd, total)} | ${pct(copies, total)} |\n`;
  }
  return md;
}

/** BioCLIP and CLIP blended at several weights, on the photos both ran on. Scores each species as
 *  rankCandidates does (best image match, blended with its name) in each model, then mixes them.
 *  No regional adjustments, so it compares like with like across weights. */
function ensembleSweep(
  queries: Query[],
  bioRuns: Map<string, PhotoRun>,
  clipRuns: Map<string, PhotoRun>,
  species: CatalogSpecies[],
  data: Float32Array,
  clipCat: { clip: Map<string, ClipSpecies>; data: Float32Array },
): string {
  const WEIGHTS = [1, 0.8, 0.6, 0.5, 0.4, 0];
  const speciesScore = (qs: Float32Array[], refs: Float32Array[], text: Float32Array | null, tw: number) => {
    let best = -Infinity;
    let frame = qs[0];
    for (const q of qs)
      for (const r of refs) {
        const d = dot(q, r);
        if (d > best) [best, frame] = [d, q];
      }
    if (best === -Infinity) return null;
    return text ? (1 - tw) * best + tw * dot(frame, text) : best;
  };
  const hits = new Map<string, number[][]>(); // class -> per weight [top1, top5]
  const counts = new Map<string, number>();
  for (const q of queries) {
    const b = bioRuns.get(q.photo);
    const c = clipRuns.get(q.photo);
    if (!b || !c) continue;
    const bq = b.unsure ? [unb64(b.crop), unb64(b.whole)] : [unb64(b.crop)];
    const cq = c.unsure ? [unb64(c.crop), unb64(c.whole)] : [unb64(c.crop)];
    const scores: Array<{ id: string; bio: number; clip: number }> = [];
    for (const s of species) {
      const own = s.id === q.species.id;
      const bioRefs = (own ? q.keep : [s.ref, ...s.gallery.map((g) => g.at)].filter((at) => at >= 0)).map((at) =>
        vec(data, at),
      );
      const cs = clipCat.clip.get(s.id);
      let clipAts = cs ? [cs.ref, ...Object.values(cs.gallery)].filter((at) => at >= 0) : [];
      if (own && cs && cs.gallery[q.photo] != null) {
        const o = vec(clipCat.data, cs.gallery[q.photo]);
        clipAts = clipAts.filter((at) => dot(vec(clipCat.data, at), o) < SAME_PHOTO);
      }
      const bio = speciesScore(bq, bioRefs, s.text >= 0 ? vec(data, s.text) : null, ID_SPACE.textWeight);
      const clip = speciesScore(
        cq,
        clipAts.map((at) => vec(clipCat.data, at)),
        cs && cs.text >= 0 ? vec(clipCat.data, cs.text) : null,
        CLIP_SPACE.textWeight,
      );
      if (bio == null || clip == null) continue;
      scores.push({ id: s.id, bio, clip });
    }
    const cls = q.species.cls;
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
    const row = hits.get(cls) ?? WEIGHTS.map(() => [0, 0]);
    WEIGHTS.forEach((w, i) => {
      const mine = scores.find((x) => x.id === q.species.id);
      if (!mine) return;
      const m = w * mine.bio + (1 - w) * mine.clip;
      const above = scores.filter((x) => w * x.bio + (1 - w) * x.clip > m).length;
      if (above === 0) row[i][0]++;
      if (above < 5) row[i][1]++;
    });
    hits.set(cls, row);
  }
  let md = `| Class | n | ${WEIGHTS.map((w) => `BioCLIP ${w}: top-1 / top-5`).join(" | ")} |\n|---|---|${WEIGHTS.map(() => "---").join("|")}|\n`;
  const total = WEIGHTS.map(() => [0, 0]);
  let n = 0;
  for (const [cls, row] of [...hits].sort()) {
    const k = counts.get(cls)!;
    n += k;
    row.forEach((r, i) => ((total[i][0] += r[0]), (total[i][1] += r[1])));
    md += `| ${cls} | ${k} | ${row.map(([a, b]) => `${pct(a, k)} / ${pct(b, k)}`).join(" | ")} |\n`;
  }
  md += `| **All** | ${n} | ${total.map(([a, b]) => `${pct(a, n)} / ${pct(b, n)}`).join(" | ")} |\n`;
  return md;
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const { species, data } = await loadCatalog();
  const byId = new Map(species.map((s) => [s.id, s]));
  const sampled = args.queries ? outsideQueries(args.queries, byId) : sample(species, data);
  const queries = args["limit-per-class"] ? firstPerClass(sampled, Number(args["limit-per-class"])) : sampled;
  console.log(`${species.length} candidate species; ${queries.length} sampled photos; detector ${detectorKey}`);

  const needClip = args.model === "clip" || args.ensemble || args["portraits-only"] || args.references;
  const clipCat = needClip ? await loadClipCatalog(species) : null;
  if (clipCat) {
    for (const s of species) {
      const c = clipCat.clip.get(s.id);
      if (!c) continue;
      const kindOf = (at: number) => (at >= 0 ? classifyReferencePhoto(vec(clipCat.data, at)).kind : PORTRAIT);
      if (s.ref >= 0 && kindOf(c.ref) !== PORTRAIT) nonPortrait.add(s.ref);
      for (const g of s.gallery) if (kindOf(c.gallery[g.photo] ?? -1) !== PORTRAIT) nonPortrait.add(g.at);
    }
  }
  if (args.references) {
    console.log(referenceStats(species, data));
    return;
  }

  const clipQueries = firstPerClass(queries, Number(args["clip-per-class"]));
  const runs =
    args.vectors === "centre"
      ? await runCentre(queries)
      : args.model === "clip"
        ? await runClip(clipQueries)
        : await runPhotos(queries);
  if (args.queries)
    for (const q of queries) {
      const run = runs.get(q.photo);
      if (run) q.keep = q.keep.filter((at) => dot(vec(data, at), unb64(run.whole)) < SAME_PHOTO);
    }
  if (args.ensemble) {
    const clipRuns = await runClip(clipQueries);
    console.log(ensembleSweep(clipQueries, runs, clipRuns, species, data, clipCat!));
    return;
  }

  // CLIP vectors of a species, in the same shape (gallery and reference photos as one list).
  const clipVectors = (s: CatalogSpecies, leaveOut?: Query): SpeciesVectors => {
    const c = clipCat!.clip.get(s.id);
    const all = c ? [c.ref, ...Object.values(c.gallery)].filter((at) => at >= 0) : [];
    let refs = all;
    if (leaveOut && c) {
      const own = c.gallery[leaveOut.photo];
      refs =
        own == null
          ? all
          : all.filter((at) => at !== own && dot(vec(clipCat!.data, at), vec(clipCat!.data, own)) < SAME_PHOTO);
    }
    return {
      ...speciesVectors(s, data),
      gallery_embeddings: refs.map((at) => vec(clipCat!.data, at)),
      text_embedding: c && c.text >= 0 ? vec(clipCat!.data, c.text) : null,
    };
  };
  const clipMode = args.model === "clip";
  const build = (s: CatalogSpecies) => (clipMode ? clipVectors(s) : speciesVectors(s, data));
  const ownVectors = (q: Query) => (clipMode ? clipVectors(q.species, q) : speciesVectors(q.species, data, q.keep));

  const global: CandidateEntry[] = species.map((s) => ({
    species: build(s),
    is_vagrant: null,
    local_tier: null,
    seasonality: null,
  }));
  const regionRows = (
    await pool.query<{
      species_id: string;
      is_vagrant: boolean | null;
      local_tier: string | null;
      weekly_frequency: number[] | null;
    }>(
      `SELECT DISTINCT ON (rs.species_id) rs.species_id, rs.is_vagrant, rs.local_tier, rs.weekly_frequency
         FROM region_species rs JOIN regions r ON r.id = rs.region_id
        WHERE $1 = ANY(r.external_codes)
        ORDER BY rs.species_id, rs.is_vagrant IS TRUE`,
      [args.region],
    )
  ).rows;
  const globalById = new Map(global.map((g) => [g.species.species_id, g.species]));
  const regional: CandidateEntry[] = regionRows
    .filter((r) => globalById.has(r.species_id))
    .map((r) => ({
      species: globalById.get(r.species_id)!,
      is_vagrant: r.is_vagrant,
      local_tier: r.local_tier,
      seasonality: monthlyFromWeekly(r.weekly_frequency),
    }));
  console.log(`Regional checklist ${args.region}: ${regional.length} species`);

  const report: Record<string, unknown> = {
    label: args.label,
    detector: detectorKey,
    perClass: PER_CLASS,
    seed: Number(args.seed),
    region: args.region,
    textWeight: SPACE.textWeight,
    vectors: args.vectors,
    model: args.model,
    portraitsOnly: args["portraits-only"],
    tuning: TUNING,
    generatedAt: new Date().toISOString(),
  };
  let md = `## ${args.label} (detector: ${detectorKey})\n\n`;
  for (const view of args.views!.split(",") as Array<"regional" | "global">) {
    const t = performance.now();
    const rows = score(
      clipMode ? clipQueries : queries,
      runs,
      { global, regional },
      byId,
      ownVectors,
      view,
      clipMode ? CLIP_SPACE : SPACE,
    );
    console.log(`Ranked ${view} in ${Math.round(performance.now() - t)} ms`);
    const perClass = [...groupBy(rows, (r) => r.cls)]
      .sort()
      .map(([c, rs]) => [c, summarize(rs)] as [string, ReturnType<typeof summarize>]);
    const families = [...groupBy(rows, (r) => `${r.cls}: ${r.family}`)]
      .filter(([, rs]) => rs.length >= 3)
      .map(([f, rs]) => [f, summarize(rs)] as [string, ReturnType<typeof summarize>])
      .sort((a, b) => a[1].top1 - b[1].top1 || b[1].n - a[1].n)
      .slice(0, 20);
    const all = summarize(rows);
    report[view] = { all, perClass: Object.fromEntries(perClass), worstFamilies: Object.fromEntries(families) };
    const name =
      view === "regional"
        ? `Within the ${args.region} checklist (plus the true species)`
        : "Against every catalog species";
    md += table(`${name}: per class`, [...perClass, ["**All**", all]]) + "\n";
    md += table(`${name}: worst 20 families (3+ photos)`, families) + "\n";
  }
  const timed = queries.map((q) => runs.get(q.photo)).filter((r): r is PhotoRun => !!r);
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  report.speed = {
    detectMsMedian: median(timed.map((r) => r.detectMs)),
    embedMsMedian: median(timed.map((r) => r.embedMs)),
    peakRssMb: peakRss ? Math.round(peakRss / 1e6) : null,
  };
  md += `Median detection ${(report.speed as { detectMsMedian: number }).detectMsMedian} ms, embedding (crop and whole) ${(report.speed as { embedMsMedian: number }).embedMsMedian} ms per photo.\n`;
  writeFileSync(path.join(args.out!, `${args.label}.json`), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(path.join(args.out!, `${args.label}.md`), md);
  console.log(md);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
