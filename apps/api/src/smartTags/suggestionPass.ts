// The smart tag suggestion pass (docs/plans/smart-tags.md, ST-2): evaluates each photo from what
// Lifer already stores (sun, date, scene and colour shares, detector count, CLIP vector) into
// capture_smart_suggestions. Never reads an original or runs an image model. A photo is evaluated
// again only when the vocabulary, calibration, engine or text model changes (the plan's version) or
// its own stored inputs do (vector, scene, frame, time, place or count arriving or changing).
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { EMBEDDING_MODEL_VERSION, MODELS_DIR, SCENE_MODEL_VERSION } from "@lifer/core/config.js";
import { pool } from "@lifer/core/db.js";
import { ensureDir } from "@lifer/core/lib/safeFs.js";
import { log } from "@lifer/core/lib/log.js";
import { embedTextVectors, isTextModelDownloaded, TEXT_MODEL_VERSION } from "@lifer/core/species/textEmbedding.js";
import {
  bindClipVectors,
  planPrompts,
  planSmartTags,
  suggestSmartTags,
  type ClipVectors,
  type SmartTagPlan,
} from "@lifer/core/smartTags/suggest.js";
import type { LightStats, ShotFraming } from "@lifer/shared";
import { createJob } from "../lib/job.js";
import { shotTypeReader } from "../stats/shotKinds.js";
import { lastOriginalInsertAt } from "../uploads/captureRows.js";

// Prompt vectors by text, embedded once and kept beside the models.
const PROMPT_CACHE = path.join(MODELS_DIR, "smart-tags-prompts.json");

async function cachedTextVectors(texts: string[]): Promise<number[][]> {
  let cache: Record<string, number[]> = {};
  try {
    const file = JSON.parse(await readFile(PROMPT_CACHE, "utf8"));
    if (file.textModel === TEXT_MODEL_VERSION) cache = file.vectors;
  } catch {
    // No cache yet, or a damaged one: embedded again below.
  }
  const missing = [...new Set(texts.filter((t) => !cache[t]))];
  if (missing.length) {
    const vectors = await embedTextVectors(missing, "background");
    missing.forEach((t, i) => (cache[t] = Array.from(vectors[i])));
    await ensureDir(MODELS_DIR);
    const tmp = `${PROMPT_CACHE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ textModel: TEXT_MODEL_VERSION, vectors: cache }));
    await rename(tmp, PROMPT_CACHE);
  }
  return texts.map((t) => cache[t]);
}

export const currentSmartTagPlan = (): SmartTagPlan =>
  planSmartTags({ imageModel: EMBEDDING_MODEL_VERSION, textModel: TEXT_MODEL_VERSION, clip: isTextModelDownloaded() });

// $1 image model, $2 scene model, $3 plan version. Scenes and frames count only for the photo the
// capture shows now, as the scene backfill does.
const JOINS = `
  LEFT JOIN capture_embeddings ce ON ce.capture_id = c.id AND ce.model_version = $1
  LEFT JOIN capture_scenes cs ON cs.capture_id = c.id AND cs.model_version = $2 AND cs.photo_id = c.current_photo_id
  LEFT JOIN capture_frames cfr ON cfr.capture_id = c.id AND cfr.photo_id = c.current_photo_id`;
const INPUTS = `md5(concat_ws('|', c.taken_at, c.lat, c.lon, c.taken_at_zoned, c.subject_count,
  ce.computed_at, cs.computed_at, cfr.computed_at))`;
const PENDING_FROM = `FROM captures_all c ${JOINS}
  LEFT JOIN capture_smart_tag_state st ON st.capture_id = c.id
  WHERE c.deleted_at IS NULL`;
const IS_PENDING = `(st.capture_id IS NULL OR st.version <> $3 OR st.inputs <> ${INPUTS})`;
const planParams = (plan: SmartTagPlan) => [EMBEDDING_MODEL_VERSION, SCENE_MODEL_VERSION, plan.version];

/** The user's photos, and how many wait for the pass. */
export async function smartTagCounts(
  userId: string,
  plan = currentSmartTagPlan(),
): Promise<{ total: number; pending: number }> {
  const res = await pool.query<{ total: number; pending: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE ${IS_PENDING})::int AS pending
     ${PENDING_FROM} AND c.user_id = $4`,
    [...planParams(plan), userId],
  );
  return res.rows[0];
}

export interface PassContext {
  plan: SmartTagPlan;
  vectors: ClipVectors | null;
  framing: ((v: ArrayLike<number>) => ShotFraming) | null;
}

async function passContext(plan: SmartTagPlan): Promise<PassContext> {
  // Without the text model the plan's version says so, and a later download evaluates everything again.
  if (!plan.clip) return { plan, vectors: null, framing: null };
  const prompts = planPrompts(plan);
  const vecs = await cachedTextVectors(prompts);
  const byPrompt = new Map(prompts.map((p, i) => [p, vecs[i]]));
  const read = await shotTypeReader(cachedTextVectors);
  return { plan, vectors: bindClipVectors(plan, (p) => byPrompt.get(p)!), framing: (v) => read(v).framing };
}

interface SignalRow {
  id: string;
  taken_at: Date | null;
  lat: string | null;
  lon: string | null;
  taken_at_zoned: boolean | null;
  subject_count: number | null;
  has_species: boolean;
  embedding: number[] | null;
  labels: Record<string, number> | null;
  colors: Record<string, number> | null;
  light: LightStats | null;
  inputs: string;
}

/** Evaluates a batch of captures and records them, suggestions and state in one transaction. */
export async function evaluateSmartTags(ids: string[], ctx: PassContext): Promise<void> {
  const { plan, vectors, framing } = ctx;
  const res = await pool.query<SignalRow>(
    `SELECT c.id, c.taken_at, c.lat, c.lon, c.taken_at_zoned, c.subject_count, c.species_id IS NOT NULL AS has_species,
            ${framing ? "ce.embedding" : "NULL::real[] AS embedding"}, cs.labels, cs.colors, cfr.light, ${INPUTS} AS inputs
     FROM captures_all c ${JOINS}
     WHERE c.id = ANY($3::uuid[])`,
    [EMBEDDING_MODEL_VERSION, SCENE_MODEL_VERSION, ids],
  );
  const cols = { capture: [] as string[], term: [] as string[], score: [] as number[], source: [] as string[] };
  for (const r of res.rows) {
    const vector = r.embedding;
    for (const s of suggestSmartTags(
      {
        takenAt: r.taken_at,
        lat: r.lat,
        lon: r.lon,
        takenAtZoned: r.taken_at_zoned,
        light: r.light,
        sceneLabels: r.labels,
        sceneColors: r.colors,
        subjectCount: r.subject_count,
        hasSpecies: r.has_species,
        framing: vector && framing ? framing(vector) : null,
        vector,
      },
      plan,
      vectors,
    )) {
      cols.capture.push(r.id);
      cols.term.push(s.termId);
      cols.score.push(s.score);
      cols.source.push(s.source);
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM capture_smart_suggestions WHERE capture_id = ANY($1::uuid[])`, [ids]);
    // A capture deleted since it was read is skipped rather than failing the batch.
    await client.query(
      `INSERT INTO capture_smart_suggestions (capture_id, term_id, score, source)
       SELECT u.* FROM unnest($1::uuid[], $2::text[], $3::real[], $4::text[]) AS u(capture_id, term_id, score, source)
       WHERE EXISTS (SELECT 1 FROM captures_all c WHERE c.id = u.capture_id)`,
      [cols.capture, cols.term, cols.score, cols.source],
    );
    await client.query(
      `INSERT INTO capture_smart_tag_state (capture_id, version, inputs)
       SELECT u.id, $3, u.inputs FROM unnest($1::uuid[], $2::text[]) AS u(id, inputs)
       WHERE EXISTS (SELECT 1 FROM captures_all c WHERE c.id = u.id)
       ON CONFLICT (capture_id) DO UPDATE SET version = EXCLUDED.version, inputs = EXCLUDED.inputs, evaluated_at = now()`,
      [res.rows.map((r) => r.id), res.rows.map((r) => r.inputs), plan.version],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Silent: a quiet pass over stored data, never shown in the dock or taskbar progress.
export const smartTagJob = createJob("smart-tag-suggestions", undefined, { silent: true });
const BATCH = 1000;

/** One pass over every photo waiting. Each batch is saved as it goes, so a stopped pass resumes
 *  where it was and no photo is evaluated twice for the same version and inputs. */
export function startSmartTagPass(): boolean {
  return smartTagJob.start(async (job) => {
    const ctx = await passContext(currentSmartTagPlan());
    const res = await pool.query<{ id: string }>(`SELECT c.id ${PENDING_FROM} AND ${IS_PENDING}`, planParams(ctx.plan));
    const ids = res.rows.map((r) => r.id);
    job.update({ total: ids.length, processed: 0 });
    for (let i = 0; i < ids.length; i += BATCH) {
      job.throwIfCancelled();
      await evaluateSmartTags(ids.slice(i, i + BATCH), ctx);
      job.update({ processed: Math.min(i + BATCH, ids.length) });
    }
    return null;
  });
}

const IMPORT_QUIET_MS = 15_000;
const TICK_MS = 30_000;

/** Starts a pass whenever photos are waiting and imports have gone quiet. */
export function scheduleSmartTagSuggestions(): void {
  const tick = async () => {
    if (smartTagJob.status.running || Date.now() - lastOriginalInsertAt < IMPORT_QUIET_MS) return;
    const any = await pool.query(
      `SELECT 1 ${PENDING_FROM} AND ${IS_PENDING} LIMIT 1`,
      planParams(currentSmartTagPlan()),
    );
    if (any.rowCount) startSmartTagPass();
  };
  setInterval(() => void tick().catch((err) => log.warn({ err }, "[smart-tags] pass failed")), TICK_MS).unref();
}
