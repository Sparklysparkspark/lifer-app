// Smart tags calibration (docs/plans/smart-tags.md, ST-0). Scores labelled photos against the
// vocabulary's CLIP prompts with Lifer's own encoders, fits per-term thresholds on one half of the
// sessions and judges them on the other. Writes calibration.json and report.txt to --out.
//
//   npm run calibrate-smart-tags -w data-pipeline -- --labels=<labels.tsv> --photos=<folder> --out=<folder>
//   npm run calibrate-smart-tags -w data-pipeline -- --bootstrap-catalog --out=<folder>
//
//   --labels             labels TSV from label-smart-tags (photo, session, taken, present, absent)
//   --photos             the folder those photo paths are relative to; read only
//   --out                where vectors.tsv, calibration.json and report.txt go (never the photos folder)
//   --vocab              vocabulary JSON (default packages/shared/src/smartTags/vocab.json)
//   --bootstrap-catalog  labels Subject terms on catalog reference photos instead (read-only SELECTs
//                        on DATABASE_URL, the Docker `lifer` catalog), as in the plan's "Measured"
//   --per-class          bootstrap photos per taxon class (default 120)
//   --fit-precision, --bar, --min-predicted   default 0.95, 0.9, 50
//
// Resumable: photo vectors are cached in <out>/vectors.tsv, so a rerun embeds only new photos.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";
import { computeEmbedding } from "@lifer/core/species/embeddings.js";
import { embedTextVectors, TEXT_MODEL_VERSION } from "@lifer/core/species/textEmbedding.js";
import { closeClip } from "../lib/clipEmbedding.js";
import {
  calibrate,
  clipTerms,
  DEFAULT_SETTINGS,
  formatLabels,
  formatReport,
  type LabelRow,
  meanUnit,
  parseLabels,
  parseVocabulary,
  scorePhoto,
  splitHalves,
  type Vocabulary,
} from "../smartTags/calibration.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
// npm run -w changes into the package folder; resolve paths against where the command was typed.
const resolveArg = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);

/** Catalog taxon classes behind each Subject term the catalog can label. Insects, spiders, plants
 *  and fungi have no catalog galleries. */
const SUBJECT_CLASSES: Record<string, string[]> = {
  "subject.bird": ["aves"],
  "subject.mammal": ["mammalia"],
  "subject.reptile": ["squamata", "testudines"],
  "subject.amphibian": ["amphibia"],
  "subject.fishes": ["actinopterygii"],
  "subject.marine-invertebrate": [
    "marine_mollusks",
    "crustacea",
    "nudibranchs",
    "echinodermata",
    "jellies_and_anemones",
    "corals",
    "cephalopoda",
    "sponges_tunicates_other",
  ],
};

type VectorCache = Map<string, number[]>;

function readVectorCache(file: string): VectorCache {
  const cache: VectorCache = new Map();
  if (!existsSync(file)) return cache;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [photo, model, vec] = line.split("\t");
    if (photo && model === EMBEDDING_MODEL_VERSION && vec) cache.set(photo, vec.split(" ").map(Number));
  }
  return cache;
}

const cacheLine = (photo: string, v: ArrayLike<number>) =>
  `${photo}\t${EMBEDDING_MODEL_VERSION}\t${Array.from(v, (x) => x.toPrecision(7)).join(" ")}\n`;

/** Labels Subject terms on one reference photo per species, read-only on the catalog DB. */
async function bootstrapCatalog(
  vocab: Vocabulary,
  perClass: number,
  out: string,
  vectorFile: string,
  cache: VectorCache,
) {
  const subjects = clipTerms(vocab).filter((t) => SUBJECT_CLASSES[t.id]);
  if (subjects.length === 0) throw new Error("The vocabulary has no Subject terms the catalog can label");
  const { pool } = await import("../db.js");
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const { rows } = await client.query<{ rid: string; sid: string; cls: string; emb: number[] }>(
      `WITH one AS (
         SELECT DISTINCT ON (g.species_id) g.reference_photo_id rid, g.species_id sid, s.taxon_class cls, g.embedding emb
         FROM species_reference_gallery_embeddings g JOIN species s ON s.id = g.species_id
         WHERE g.model_version = $1 AND s.taxon_class IS NOT NULL
         ORDER BY g.species_id, md5(g.reference_photo_id::text)
       ), ranked AS (SELECT *, row_number() OVER (PARTITION BY cls ORDER BY md5(sid::text)) rn FROM one)
       SELECT rid, sid, cls, emb FROM ranked WHERE rn <= $2`,
      [EMBEDDING_MODEL_VERSION, perClass],
    );
    await client.query("COMMIT");
    const labels: LabelRow[] = rows.map((r) => {
      const present = subjects.filter((t) => SUBJECT_CLASSES[t.id].includes(r.cls)).map((t) => t.id);
      const photo = `ref:${r.rid}`;
      if (!cache.has(photo)) {
        cache.set(photo, r.emb);
        appendFileSync(vectorFile, cacheLine(photo, r.emb));
      }
      // Whole species on one side of the split: the species id is the session.
      return {
        photo,
        session: r.sid,
        taken: "",
        present,
        absent: subjects.map((t) => t.id).filter((id) => !present.includes(id)),
      };
    });
    const file = path.join(out, "catalog-labels.tsv");
    writeFileSync(file, formatLabels(labels));
    console.log(
      `[calibrate-smart-tags] labelled ${labels.length} catalog reference photos for ${subjects.map((t) => t.label).join(", ")}`,
    );
    return { labels, file };
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      labels: { type: "string" },
      photos: { type: "string" },
      out: { type: "string" },
      vocab: { type: "string" },
      "bootstrap-catalog": { type: "boolean", default: false },
      "per-class": { type: "string", default: "120" },
      "fit-precision": { type: "string", default: String(DEFAULT_SETTINGS.fitPrecision) },
      bar: { type: "string", default: String(DEFAULT_SETTINGS.bar) },
      "min-predicted": { type: "string", default: String(DEFAULT_SETTINGS.minPredicted) },
    },
  });
  if (!values.out) throw new Error("--out=<folder> is required");
  const bootstrap = values["bootstrap-catalog"]!;
  if (!bootstrap && (!values.labels || !values.photos))
    throw new Error("--labels and --photos are required (or --bootstrap-catalog)");
  const out = resolveArg(values.out);
  const photosDir = values.photos ? resolveArg(values.photos) : null;
  const rel = photosDir == null ? null : path.relative(photosDir, out);
  if (rel != null && !rel.startsWith("..") && !path.isAbsolute(rel))
    throw new Error("--out must be outside the photos folder");
  mkdirSync(out, { recursive: true });
  const settings = {
    fitPrecision: Number(values["fit-precision"]),
    bar: Number(values.bar),
    minPredicted: Number(values["min-predicted"]),
  };

  const vocabFile = values.vocab
    ? resolveArg(values.vocab)
    : path.join(REPO_ROOT, "packages/shared/src/smartTags/vocab.json");
  const vocab = parseVocabulary(JSON.parse(readFileSync(vocabFile, "utf8")));
  const terms = clipTerms(vocab);
  const vectorFile = path.join(out, "vectors.tsv");
  const cache = readVectorCache(vectorFile);

  let labels: LabelRow[];
  let labelsFile: string;
  if (bootstrap) {
    ({ labels, file: labelsFile } = await bootstrapCatalog(vocab, Number(values["per-class"]), out, vectorFile, cache));
  } else {
    labelsFile = resolveArg(values.labels!);
    labels = parseLabels(readFileSync(labelsFile, "utf8")).filter(
      (r) => r.present.length || r.absent === "*" || r.absent.length,
    );
  }

  try {
    const missing = labels.filter((r) => !cache.has(r.photo));
    if (missing.length) console.log(`[calibrate-smart-tags] embedding ${missing.length} photos (${cache.size} cached)`);
    for (const [i, r] of missing.entries()) {
      try {
        const v = await computeEmbedding(await readFile(path.join(photosDir!, r.photo)));
        cache.set(r.photo, v);
        appendFileSync(vectorFile, cacheLine(r.photo, v));
      } catch (err) {
        console.error(`[calibrate-smart-tags] skipped ${r.photo}: ${(err as Error).message}`);
      }
      if ((i + 1) % 50 === 0) console.log(`[calibrate-smart-tags] ${i + 1}/${missing.length}`);
    }
    labels = labels.filter((r) => cache.has(r.photo));

    const promptsOf = new Map(terms.map((t) => [t.id, t.prompts]));
    const groups = [...new Set(terms.flatMap((t) => (t.pickOne ? [t.pickOne] : [])))];
    const noneOf = new Map(groups.map((g) => [g, vocab.none[g] ?? []]));
    for (const [g, p] of noneOf)
      if (!p.length) console.warn(`[calibrate-smart-tags] pick-one group ${g} has no "none" prompts`);
    const all = [...promptsOf.values(), ...noneOf.values()].flat();
    const vecs = await embedTextVectors(all, "background");
    let k = 0;
    const take = (n: number) => meanUnit(vecs.slice(k, (k += n)));
    const termVectors = new Map([...promptsOf].map(([id, p]) => [id, take(p.length)]));
    const noneVectors = new Map([...noneOf].filter(([, p]) => p.length).map(([g, p]) => [g, take(p.length)]));

    const scores = new Map(
      labels.map((r) => [r.photo, scorePhoto(cache.get(r.photo)!, terms, termVectors, noneVectors)]),
    );
    const halves = splitHalves(labels);
    const results = calibrate(terms, labels, scores, halves, settings);
    const side = (h: 0 | 1) => labels.filter((r) => halves.get(r.photo) === h);
    const sessions = (h: 0 | 1) => new Set(side(h).map((r) => r.session)).size;

    const calibration = {
      vocabVersion: vocab.version,
      imageModel: EMBEDDING_MODEL_VERSION,
      textModel: TEXT_MODEL_VERSION,
      labels: labelsFile,
      settings,
      createdAt: new Date().toISOString(),
      halves: {
        fit: { photos: side(0).length, sessions: sessions(0) },
        heldOut: { photos: side(1).length, sessions: sessions(1) },
      },
      terms: results,
    };
    writeFileSync(path.join(out, "calibration.json"), JSON.stringify(calibration, null, 2) + "\n");
    const report = formatReport(results, {
      labelsFile,
      vocabVersion: vocab.version,
      settings,
      photos: [side(0).length, side(1).length],
      sessions: [sessions(0), sessions(1)],
    });
    writeFileSync(path.join(out, "report.txt"), report);
    console.log(report);
    console.log(`[calibrate-smart-tags] wrote ${path.join(out, "calibration.json")} and report.txt`);
  } finally {
    await closeClip();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
