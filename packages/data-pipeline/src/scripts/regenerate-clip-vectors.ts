// Computes CLIP image vectors at clip-vit-l14-v2 for every species reference photo and gallery
// photo, with the full-precision model on the fastest backend that agrees with the CPU (the Mac's
// GPU when it can), through the app's own inference code so the preprocessing matches installs.
//
//   npx tsx src/scripts/regenerate-clip-vectors.ts              compute what's missing
//   npx tsx src/scripts/regenerate-clip-vectors.ts --limit=20   just 20 photos, to test
//   npx tsx src/scripts/regenerate-clip-vectors.ts --dry-run    count what's missing, compute nothing
//   npx tsx src/scripts/regenerate-clip-vectors.ts --apply      copy the new vectors over the old ones
//     (--allow-pending=N lets up to N unreadable photos go without)
//
// species_reference_embeddings and species_reference_gallery_embeddings hold one row per photo,
// so new vectors go to clip_vector_regen first and the old ones keep serving until --apply.
// A staged vector counts as done only while its photo's path is unchanged, so reruns pick up just
// new or replaced photos. --model=<fp32.onnx> or CLIP_V2_FP32_MODEL; default under data/build/models.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pool } from "../db.js";

const MODEL_VERSION = "clip-vit-l14-v2";
const PIPELINE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILD_DIR = path.join(PIPELINE_DIR, "data", "build");
const SPECIES_DIR = path.join(PIPELINE_DIR, "..", "core", "src", "species");
const DEFAULT_MODEL = path.join(BUILD_DIR, "models", `${MODEL_VERSION}-fp32.onnx`);
const BATCH = 200;
// Keeps the inference worker fed while results are written.
const IN_FLIGHT = 4;
const DIMS = [1, 3, 224, 224];

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);

type Kind = "reference" | "gallery";
interface Pending {
  kind: Kind;
  rowId: string;
  speciesId: string;
  path: string;
}

// Imported at runtime: apps/api sits outside this package's TypeScript project.
interface Inference {
  analyzeImage(image: { path: string }, opts: { targets: unknown[]; priority: "background" }): Promise<{ vectors: Array<Float32Array | { error: string }> }>;
  isInferenceStuck(): boolean;
  stopInference(): Promise<void>;
}
const load = <T>(file: string) => import(pathToFileURL(path.join(SPECIES_DIR, file)).href) as Promise<T>;

async function ensureTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clip_vector_regen (
      kind text NOT NULL,
      row_id uuid NOT NULL,
      species_id uuid NOT NULL,
      model_version text NOT NULL,
      source_path text NOT NULL,
      embedding real[] NOT NULL,
      computed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, row_id, model_version)
    )`);
}

async function findPending(): Promise<{ pending: Pending[]; noFile: number }> {
  const staged = (await pool.query(`SELECT to_regclass('clip_vector_regen') AS t`)).rows[0].t !== null;
  const notStaged = (kind: Kind, idCol: string, pathCol: string) =>
    staged
      ? `AND NOT EXISTS (SELECT 1 FROM clip_vector_regen r WHERE r.kind = '${kind}' AND r.row_id = ${idCol}
           AND r.model_version = $1 AND r.source_path = ${pathCol})`
      : "";
  const res = await pool.query<{ kind: Kind; row_id: string; species_id: string; path: string }>(
    `SELECT 'reference' AS kind, s.id AS row_id, s.id AS species_id, s.reference_display_path AS path
     FROM species s WHERE s.reference_display_path IS NOT NULL ${notStaged("reference", "s.id", "s.reference_display_path")}
     UNION ALL
     SELECT 'gallery', p.id, p.species_id, p.display_path
     FROM species_reference_photos p WHERE p.display_path IS NOT NULL ${notStaged("gallery", "p.id", "p.display_path")}
     ORDER BY 1 DESC, 2`,
    staged ? [MODEL_VERSION] : [],
  );
  const pending: Pending[] = [];
  let noFile = 0;
  for (const r of res.rows) {
    if (existsSync(r.path)) pending.push({ kind: r.kind, rowId: r.row_id, speciesId: r.species_id, path: r.path });
    else noFile++;
  }
  return { pending, noFile };
}

async function write(rows: Array<Pending & { embedding: number[] }>): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const values = rows.map((r) => {
    params.push(r.kind, r.rowId, r.speciesId, MODEL_VERSION, r.path, r.embedding);
    const n = params.length;
    return `($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
  });
  await pool.query(
    `INSERT INTO clip_vector_regen (kind, row_id, species_id, model_version, source_path, embedding)
     VALUES ${values.join(", ")}
     ON CONFLICT (kind, row_id, model_version)
     DO UPDATE SET species_id = EXCLUDED.species_id, source_path = EXCLUDED.source_path, embedding = EXCLUDED.embedding, computed_at = now()`,
    params,
  );
}

// Swaps every staged vector in at once, only when nothing with a photo on disk is still missing.
async function apply(): Promise<void> {
  const { pending, noFile } = await findPending();
  // A photo that can't be read stays pending for good: --allow-pending=N lets up to N go without.
  const allowed = Number(arg("allow-pending") ?? 0);
  if (pending.length > allowed) {
    console.error(
      `[regenerate-clip-vectors] ${pending.length} photos still need a ${MODEL_VERSION} vector: run without --apply first` +
        ` (or pass --allow-pending=${pending.length} if they can't be read)`,
    );
    process.exitCode = 1;
    return;
  }
  if (pending.length > 0) console.log(`[regenerate-clip-vectors] applying without ${pending.length} photos that have no ${MODEL_VERSION} vector`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ref = await client.query(
      `UPDATE species_reference_embeddings e SET embedding = r.embedding, model_version = r.model_version, computed_at = r.computed_at
       FROM clip_vector_regen r JOIN species s ON s.id = r.row_id AND s.reference_display_path = r.source_path
       WHERE r.kind = 'reference' AND r.model_version = $1 AND e.species_id = r.row_id`,
      [MODEL_VERSION],
    );
    const refNew = await client.query(
      `INSERT INTO species_reference_embeddings (species_id, embedding, model_version, computed_at)
       SELECT r.row_id, r.embedding, r.model_version, r.computed_at
       FROM clip_vector_regen r JOIN species s ON s.id = r.row_id AND s.reference_display_path = r.source_path
       WHERE r.kind = 'reference' AND r.model_version = $1
       ON CONFLICT (species_id) DO NOTHING`,
      [MODEL_VERSION],
    );
    const gal = await client.query(
      `UPDATE species_reference_gallery_embeddings e SET species_id = p.species_id, embedding = r.embedding, model_version = r.model_version, computed_at = r.computed_at
       FROM clip_vector_regen r JOIN species_reference_photos p ON p.id = r.row_id AND p.display_path = r.source_path
       WHERE r.kind = 'gallery' AND r.model_version = $1 AND e.reference_photo_id = r.row_id`,
      [MODEL_VERSION],
    );
    const galNew = await client.query(
      `INSERT INTO species_reference_gallery_embeddings (reference_photo_id, species_id, embedding, model_version, computed_at)
       SELECT r.row_id, p.species_id, r.embedding, r.model_version, r.computed_at
       FROM clip_vector_regen r JOIN species_reference_photos p ON p.id = r.row_id AND p.display_path = r.source_path
       WHERE r.kind = 'gallery' AND r.model_version = $1
       ON CONFLICT (reference_photo_id) DO NOTHING`,
      [MODEL_VERSION],
    );
    await client.query("COMMIT");
    console.log(
      `[regenerate-clip-vectors] applied: ${ref.rowCount! + refNew.rowCount!} reference and ${gal.rowCount! + galNew.rowCount!} gallery vectors now ${MODEL_VERSION}` +
        (noFile ? `; ${noFile} photos with no file on disk keep their old vectors` : ""),
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const fmt = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

async function main(): Promise<void> {
  if (flag("apply")) return apply();
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const modelPath = path.resolve(arg("model") ?? process.env.CLIP_V2_FP32_MODEL ?? DEFAULT_MODEL);

  const { pending: all, noFile } = await findPending();
  const pending = all.slice(0, limit);
  const refs = all.filter((p) => p.kind === "reference").length;
  console.log(
    `[regenerate-clip-vectors] ${all.length} photos need a ${MODEL_VERSION} vector (${refs} reference, ${all.length - refs} gallery)` +
      (noFile ? `, ${noFile} skipped with no file on disk` : ""),
  );
  if (flag("dry-run") || pending.length === 0) return;
  if (!existsSync(modelPath)) {
    console.error(
      `[regenerate-clip-vectors] no full-precision model at ${modelPath}. Make it with ` +
        `"packages/data-pipeline/.venv/bin/python packages/data-pipeline/python/export_clip_model.py ${path.dirname(modelPath)}" ` +
        `(downloads 1.2 GB), or pass --model=<path to ${MODEL_VERSION}-fp32.onnx>.`,
    );
    process.exitCode = 1;
    return;
  }

  await ensureTable();
  // The CPU and GPU both run the fp32 file, so the vectors are full precision on either.
  const { selectAcceleration } = await load<{ selectAcceleration(o: unknown): Promise<void> }>("accelerationSelect.ts");
  const { placementFor } = await load<{ placementFor(f: string, p: string): { modelPath: string; providers?: unknown[] } }>("acceleration.ts");
  const inference = await load<Inference>("inference.ts");
  await selectAcceleration({
    cacheFile: path.join(BUILD_DIR, "regenerate-clip-vectors-acceleration.json"),
    gpuRuntimeRoot: path.join(BUILD_DIR, "gpu-runtime"),
    models: [{ family: "clip", cpuPath: modelPath, gpuPath: modelPath, downloadGpuCopy: async () => {}, dims: DIMS }],
    log: (m: string) => console.log(`[regenerate-clip-vectors] acceleration: ${m}`),
  });
  const placement = placementFor("clip", modelPath);
  const target = { ...placement, missingMessage: `Missing ${modelPath}`, crop: false };
  console.log(`[regenerate-clip-vectors] running on ${placement.providers?.map((p) => (typeof p === "string" ? p : (p as { name: string }).name)).join("+") ?? "cpu"}`);

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log("\n[regenerate-clip-vectors] stopping after the current batch (Ctrl+C again to quit now)");
  });

  const start = Date.now();
  let done = 0;
  let failed = 0;
  let lastLog = start;
  let buffer: Array<Pending & { embedding: number[] }> = [];
  const embed = async (p: Pending) => {
    try {
      const { vectors } = await inference.analyzeImage({ path: p.path }, { targets: [target], priority: "background" });
      const v = vectors[0];
      if (!(v instanceof Float32Array)) throw new Error(v.error);
      buffer.push({ ...p, embedding: Array.from(v) });
      done++;
    } catch (err) {
      failed++;
      console.error(`[regenerate-clip-vectors] FAILED ${p.kind} ${p.rowId} (${p.path}): ${(err as Error).message}`);
    }
  };

  let next = 0;
  let writing = Promise.resolve();
  const lane = async () => {
    while (next < pending.length && !stopping) {
      if (inference.isInferenceStuck()) {
        if (!stopping) console.error("[regenerate-clip-vectors] the model keeps timing out, stopping; rerun to continue");
        stopping = true;
        process.exitCode = 1;
        break;
      }
      await embed(pending[next++]);
      if (buffer.length >= BATCH) {
        const rows = buffer;
        buffer = [];
        writing = writing.then(() => write(rows));
        await writing;
      }
      if (Date.now() - lastLog > 30_000) {
        lastLog = Date.now();
        const rate = done / ((lastLog - start) / 1000);
        const left = pending.length - done - failed;
        console.log(`[regenerate-clip-vectors] ${done + failed}/${pending.length}, ${rate.toFixed(1)}/s, about ${fmt(left / rate)} left`);
      }
    }
  };
  await Promise.all(Array.from({ length: IN_FLIGHT }, lane));
  await writing;
  await write(buffer);
  await inference.stopInference();
  const secs = (Date.now() - start) / 1000;
  console.log(`[regenerate-clip-vectors] done: ${done} computed, ${failed} failed, ${(done / secs).toFixed(1)}/s over ${fmt(secs)}`);
  if (done + failed < all.length) console.log(`[regenerate-clip-vectors] ${all.length - done - failed} left: rerun to continue`);
  else console.log(`[regenerate-clip-vectors] every photo has a ${MODEL_VERSION} vector: --apply swaps them in when publishing`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
