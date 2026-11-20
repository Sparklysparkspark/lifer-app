// Near-identical photos (bursts and repeats): the same species, taken close together, with almost
// the same whole-photo CLIP vector. Worked out on demand from the vectors stored at import. Only
// photos with a same-species neighbour a few minutes away are compared at all, each against a
// bounded number of earlier frames, and each run's answer is kept until one of its photos changes,
// so after an import only the runs it touched are compared again.
import { createHash } from "node:crypto";
import { pool } from "@lifer/core/db.js";
import { captureVectors, cosineSimilarity, CLIP_SPACE } from "@lifer/core/species/embeddings.js";

/** How alike two photos must be to count as the same shot, by how far apart they were taken. */
export const SIMILAR_RULES = [
  // A burst: the animal moved a little between frames.
  { withinMs: 15_000, minSimilarity: 0.9 },
  // A repeat: the same scene shot again a little later.
  { withinMs: 180_000, minSimilarity: 0.94 },
] as const;
const MAX_GAP_MS = SIMILAR_RULES[SIMILAR_RULES.length - 1].withinMs;
// Chained links keep a long burst together, so a frame only needs checking against recent ones.
const LOOKBACK = 30;
const VECTOR_BATCH = 2000;

export interface SimilarCandidate {
  id: string;
  speciesId: string;
  /** taken_at in epoch milliseconds. */
  takenAt: number;
  computedAt: string;
}

/** Splits candidates sorted by species then time into runs: the same species, each photo within
 *  the widest rule of the one before. A photo alone in its run can't be in a group, so it's left out. */
export function candidateRuns(rows: readonly SimilarCandidate[]): SimilarCandidate[][] {
  const runs: SimilarCandidate[][] = [];
  let run: SimilarCandidate[] = [];
  for (const row of rows) {
    const prev = run.at(-1);
    if (prev && prev.speciesId === row.speciesId && row.takenAt - prev.takenAt <= MAX_GAP_MS) run.push(row);
    else {
      if (run.length > 1) runs.push(run);
      run = [row];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

function linked(gapMs: number, similarity: number): boolean {
  return SIMILAR_RULES.some((r) => gapMs <= r.withinMs && similarity >= r.minSimilarity);
}

/** A pair of photos as stored in similar_dismissals: the smaller id first. */
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** One run's groups of two or more, each in time order. Photos link when a rule matches; a group
 *  is everything linked to it, so a burst that drifts frame by frame stays one group. */
export function groupRun(
  run: readonly SimilarCandidate[],
  vectors: ReadonlyMap<string, ArrayLike<number>>,
  dismissed: ReadonlySet<string> = new Set(),
): string[][] {
  const parent = run.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let i = 1; i < run.length; i++) {
    const vi = vectors.get(run[i].id);
    if (!vi) continue;
    for (let j = i - 1; j >= 0 && j >= i - LOOKBACK; j--) {
      const gap = run[i].takenAt - run[j].takenAt;
      if (gap > MAX_GAP_MS) break;
      const vj = vectors.get(run[j].id);
      // shortcut: only a direct link is blocked, so a new photo that links to both of a dismissed pair
      // brings them back together; upgrade if that surprises anyone.
      if (dismissed.has(pairKey(run[i].id, run[j].id))) continue;
      if (vj && find(i) !== find(j) && linked(gap, cosineSimilarity(vi, vj))) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, string[]>();
  run.forEach((c, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(c.id);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

const runKey = (run: readonly SimilarCandidate[]) =>
  createHash("sha1")
    .update(run.map((c) => `${c.id}|${c.takenAt}|${c.computedAt}`).join(","))
    .digest("base64url");

// Per user, each run's groups by the run's contents: a run that hasn't changed isn't compared again.
const runGroupsCache = new Map<string, Map<string, string[][]>>();

async function dismissedPairs(userId: string, captureIds: string[]): Promise<Set<string>> {
  const res = await pool.query<{ capture_a: string; capture_b: string }>(
    `SELECT capture_a, capture_b FROM similar_dismissals WHERE user_id = $1 AND capture_a = ANY($2::uuid[])`,
    [userId, captureIds],
  );
  return new Set(res.rows.map((r) => pairKey(r.capture_a, r.capture_b)));
}

/** "Keep all" and "Not similar": the photo's whole group stops being offered. Returns the group's
 *  photos, which is also what undoing needs. */
export async function dismissSimilarGroup(userId: string, captureId: string): Promise<string[]> {
  const ids = await similarGroupOf(userId, captureId);
  await setDismissed(userId, ids, true);
  return ids;
}

/** Records or clears every pair among `captureIds` (only ones the user owns). */
export async function setDismissed(userId: string, captureIds: string[], dismissed: boolean): Promise<void> {
  const ids = [...new Set(captureIds)].sort();
  if (ids.length < 2) return;
  await pool.query(
    dismissed
      ? `INSERT INTO similar_dismissals (user_id, capture_a, capture_b)
         SELECT $1, a.id, b.id FROM captures a JOIN captures b ON a.id < b.id
          WHERE a.user_id = $1 AND b.user_id = $1 AND a.id = ANY($2::uuid[]) AND b.id = ANY($2::uuid[])
         ON CONFLICT DO NOTHING`
      : `DELETE FROM similar_dismissals WHERE user_id = $1 AND capture_a = ANY($2::uuid[]) AND capture_b = ANY($2::uuid[])`,
    [userId, ids],
  );
  // The kept answers were worked out without this change.
  runGroupsCache.delete(userId);
}

async function groupRuns(userId: string, runs: SimilarCandidate[][], keepOthers: boolean): Promise<string[][][]> {
  const cached = runGroupsCache.get(userId) ?? new Map<string, string[][]>();
  const keys = runs.map(runKey);
  const out: string[][][] = runs.map((_, i) => cached.get(keys[i]) ?? []);
  const todo = runs.map((_, i) => i).filter((i) => !cached.has(keys[i]));
  // Vectors are read a batch of runs at a time, so a library of bursts never holds them all at once.
  for (let start = 0; start < todo.length;) {
    const batch: number[] = [];
    let size = 0;
    while (start < todo.length && (batch.length === 0 || size + runs[todo[start]].length <= VECTOR_BATCH)) {
      size += runs[todo[start]].length;
      batch.push(todo[start++]);
    }
    const rows = batch.flatMap((i) => runs[i].map((c) => ({ capture_id: c.id, computed_at: c.computedAt })));
    const vectors = await captureVectors(pool, CLIP_SPACE.captureTable, CLIP_SPACE.modelVersion, rows);
    const dismissed = await dismissedPairs(
      userId,
      rows.map((r) => r.capture_id),
    );
    for (const i of batch) out[i] = groupRun(runs[i], vectors, dismissed);
  }
  const next = keepOthers ? cached : new Map<string, string[][]>();
  runs.forEach((_, i) => next.set(keys[i], out[i]));
  runGroupsCache.set(userId, next);
  return out;
}

async function candidates(userId: string, speciesId?: string): Promise<SimilarCandidate[]> {
  // The `captures` view: trashed and hidden photos are never offered for review.
  const res = await pool.query<{ id: string; species_id: string; t: number; computed_at: string }>(
    `SELECT c.id, c.species_id, (extract(epoch FROM c.taken_at) * 1000)::float8 AS t, ce.computed_at::text AS computed_at
       FROM captures c
       JOIN ${CLIP_SPACE.captureTable} ce ON ce.capture_id = c.id AND ce.model_version = $2
      WHERE c.user_id = $1 AND c.taken_at IS NOT NULL ${speciesId ? "AND c.species_id = $3" : ""}
      ORDER BY c.species_id, c.taken_at, c.id`,
    speciesId ? [userId, CLIP_SPACE.modelVersion, speciesId] : [userId, CLIP_SPACE.modelVersion],
  );
  return res.rows.map((r) => ({ id: r.id, speciesId: r.species_id, takenAt: Number(r.t), computedAt: r.computed_at }));
}

// Two requests at once (a page and a reload) share one pass.
const inFlight = new Map<string, Promise<string[][]>>();

/** Every group of near-identical photos, largest first, then newest first. */
export function similarGroups(userId: string): Promise<string[][]> {
  let pass = inFlight.get(userId);
  if (!pass) {
    pass = (async () => {
      const rows = await candidates(userId);
      const takenAt = new Map(rows.map((r) => [r.id, r.takenAt]));
      const groups = (await groupRuns(userId, candidateRuns(rows), false)).flat();
      return groups.sort((a, b) => b.length - a.length || takenAt.get(b[0])! - takenAt.get(a[0])!);
    })().finally(() => inFlight.delete(userId));
    inFlight.set(userId, pass);
  }
  return pass;
}

/** The group a photo belongs to, in time order, or just the photo when it has no near-duplicates.
 *  Empty when the capture isn't this user's. */
export async function similarGroupOf(userId: string, captureId: string): Promise<string[]> {
  const res = await pool.query<{ species_id: string }>(
    `SELECT species_id FROM captures WHERE id = $1 AND user_id = $2`,
    [captureId, userId],
  );
  const speciesId = res.rows[0]?.species_id;
  if (!speciesId) return [];
  const run = candidateRuns(await candidates(userId, speciesId)).find((r) => r.some((c) => c.id === captureId));
  if (!run) return [captureId];
  const [groups] = await groupRuns(userId, [run], true);
  return groups.find((g) => g.includes(captureId)) ?? [captureId];
}
