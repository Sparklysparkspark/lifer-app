// Adapted from the companion app.
// Bursts and scenes: the frames of one press of the shutter, and the run of bursts taken at one
// sighting. Pure: the caller loads the frames around a photo (sceneRoutes.ts) and groups them here.
import { cosineSimilarity } from "@lifer/core/species/embeddings.js";

/** Burst gap when both frames carry the camera's sub-second time: most bodies fire 3 to 30 frames
 *  a second, so half a second apart is already another press. */
export const BURST_GAP_MS = 500;
/** Burst gap when either time is whole seconds: frames of one press can read a full second apart. */
export const BURST_GAP_WHOLE_SECOND_MS = 1000;
/** A burst is cut where the picture changes completely between neighbouring frames. */
export const BURST_SPLIT_BELOW = 0.65;
/** Pieces of one camera this alike a moment apart are one burst (a pause while the bird turned). */
export const BURST_JOIN = { withinMs: 15_000, minSimilarity: 0.9 } as const;
// Chained links keep a long burst together, so a frame only needs checking against recent ones.
const LOOKBACK = 30;

/** A new scene starts when the gap between bursts is over this. */
export const SCENE_GAP_MS = 5 * 60_000;
/** Or when the camera moved this far (metres) between bursts. */
export const SCENE_MOVE_M = 200;
/** Neighbouring bursts this alike (cosine of their mean vectors) are the same subject. */
export const SAME_SUBJECT = 0.8;
/** Bursts without vectors are kept apart by what costs nothing: another camera or lens, or a gap
 *  well over the usual gap between bursts (CHEAP_GAP_TIMES its median, at least CHEAP_GAP_MS). */
export const CHEAP_GAP_MS = 2 * 60_000;
export const CHEAP_GAP_TIMES = 8;
/** The most frames a scene answer holds; more is cut around the photo and marked truncated. */
export const SCENE_MAX_FRAMES = 300;

export interface SceneFrame {
  id: string;
  /** Capture time in epoch milliseconds, with the sub-second when the camera wrote one. */
  at: number;
  /** The camera body; frames of different bodies are never one burst. */
  body: string | null;
  lens: string | null;
  lat: number | null;
  lon: number | null;
}

type Vectors = ReadonlyMap<string, ArrayLike<number>>;

// Whole-second times are all a camera without SubSecTimeOriginal gives.
const hasSubSecond = (f: SceneFrame) => Math.round(f.at) % 1000 !== 0;
const burstGap = (a: SceneFrame, b: SceneFrame) =>
  hasSubSecond(a) && hasSubSecond(b) ? BURST_GAP_MS : BURST_GAP_WHOLE_SECOND_MS;
const byTime = (a: SceneFrame, b: SceneFrame) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Bursts (frame ids in time order), ordered by their first frame. */
export function groupBursts(frames: readonly SceneFrame[], vectors: Vectors = new Map()): string[][] {
  const byId = new Map(frames.map((f) => [f.id, f]));
  const sorted = [...frames].sort(byTime);
  // 1. Time: per body, a new group after a gap.
  const timeGroups: SceneFrame[][] = [];
  const open = new Map<string, SceneFrame[]>();
  for (const f of sorted) {
    const key = f.body ?? "";
    const cur = open.get(key);
    const last = cur?.at(-1);
    if (cur && last && f.at - last.at <= burstGap(last, f)) cur.push(f);
    else {
      const next = [f];
      timeGroups.push(next);
      open.set(key, next);
    }
  }
  // 2. Cut at a picture change.
  const pieces: string[][] = [];
  for (const group of timeGroups) {
    let cur: string[] = [];
    for (const f of group) {
      const a = cur.length ? vectors.get(cur[cur.length - 1]) : undefined;
      const b = vectors.get(f.id);
      if (a && b && cosineSimilarity(a, b) < BURST_SPLIT_BELOW) {
        pieces.push(cur);
        cur = [];
      }
      cur.push(f.id);
    }
    pieces.push(cur);
  }
  // 3. Join pieces of one body whose frames look near-identical a moment apart; only the piece
  // just before joins, never across a different-looking piece in between.
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const owner = new Map<string, number>();
  pieces.forEach((p, i) => p.forEach((id) => owner.set(id, i)));
  const perBody = new Map<string, SceneFrame[]>();
  for (const f of sorted) perBody.set(f.body ?? "", [...(perBody.get(f.body ?? "") ?? []), f]);
  for (const list of perBody.values()) {
    for (let i = 1; i < list.length; i++) {
      const vi = vectors.get(list[i].id);
      if (!vi) continue;
      let before: number | undefined;
      for (let j = i - 1; j >= 0 && j >= i - LOOKBACK; j--) {
        if (list[i].at - list[j].at > BURST_JOIN.withinMs) break;
        const oj = owner.get(list[j].id)!;
        if (oj !== owner.get(list[i].id)) {
          before ??= oj;
          if (oj !== before) break;
        }
        const pi = find(owner.get(list[i].id)!);
        const pj = find(oj);
        const vj = vectors.get(list[j].id);
        if (pi !== pj && vj && cosineSimilarity(vi, vj) >= BURST_JOIN.minSimilarity) parent[pi] = pj;
      }
    }
  }
  const merged = new Map<number, string[]>();
  pieces.forEach((p, i) => merged.set(find(i), [...(merged.get(find(i)) ?? []), ...p]));
  const at = (id: string) => byId.get(id)!;
  return [...merged.values()]
    .map((ids) => ids.map(at).sort(byTime))
    .sort((a, b) => byTime(a[0], b[0]))
    .map((g) => g.map((f) => f.id));
}

/** Great-circle distance in metres. */
export function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * rad) / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(h));
}

interface BurstFacts {
  start: number;
  end: number;
  lat: number | null;
  lon: number | null;
  body: string | null;
  lens: string | null;
  mean: Float32Array | null;
}

function factsOf(ids: string[], byId: ReadonlyMap<string, SceneFrame>, vectors: Vectors): BurstFacts {
  const frames = ids.map((id) => byId.get(id)!);
  const placed = frames.filter((f) => f.lat != null && f.lon != null);
  const vs = ids.map((id) => vectors.get(id)).filter((v): v is ArrayLike<number> => !!v);
  let mean: Float32Array | null = null;
  if (vs.length) {
    mean = new Float32Array(vs[0].length);
    for (const v of vs) for (let i = 0; i < mean.length; i++) mean[i] += v[i];
    const norm = Math.hypot(...mean) || 1;
    for (let i = 0; i < mean.length; i++) mean[i] /= norm;
  }
  return {
    start: frames[0].at,
    end: frames[frames.length - 1].at,
    lat: placed.length ? placed.reduce((s, f) => s + f.lat!, 0) / placed.length : null,
    lon: placed.length ? placed.reduce((s, f) => s + f.lon!, 0) / placed.length : null,
    body: frames.find((f) => f.body)?.body ?? null,
    lens: frames.find((f) => f.lens)?.lens ?? null,
    mean,
  };
}

/** Scenes: runs of bursts (as groupBursts returns them, in order), each a list of bursts. */
export function groupScenes(
  bursts: readonly string[][],
  frames: readonly SceneFrame[],
  vectors: Vectors = new Map(),
): string[][][] {
  const byId = new Map(frames.map((f) => [f.id, f]));
  const facts = bursts.map((ids) => factsOf(ids, byId, vectors));
  const gaps = facts
    .slice(1)
    .map((b, i) => b.start - facts[i].end)
    .filter((g) => g >= 0)
    .sort((x, y) => x - y);
  const wide = Math.max(CHEAP_GAP_MS, CHEAP_GAP_TIMES * (gaps[Math.floor(gaps.length / 2)] ?? 0));
  const differs = (a: string | null, b: string | null) => !!a && !!b && a !== b;
  const join = (prev: BurstFacts, next: BurstFacts) => {
    if (prev.mean && next.mean) return cosineSimilarity(prev.mean, next.mean) >= SAME_SUBJECT;
    if (differs(prev.body, next.body) || differs(prev.lens, next.lens)) return false;
    return next.start - prev.end <= wide;
  };
  const scenes: string[][][] = [];
  let prev: BurstFacts | null = null;
  let end = 0;
  facts.forEach((b, i) => {
    const apart =
      !prev ||
      b.start - end > SCENE_GAP_MS ||
      (prev.lat !== null && b.lat !== null && metresBetween(prev.lat, prev.lon!, b.lat, b.lon!) > SCENE_MOVE_M) ||
      !join(prev, b);
    if (apart) scenes.push([bursts[i]]);
    else scenes[scenes.length - 1].push(bursts[i]);
    end = apart ? b.end : Math.max(end, b.end);
    prev = b;
  });
  return scenes;
}

export interface SceneAnswer {
  /** The scene's bursts, each frame ids in time order. */
  bursts: string[][];
  /** Where the photo is: its burst in `bursts`, and its frame in that burst. */
  burst: number;
  frame: number;
  /** Frames were left out to keep to `max`. */
  truncated: boolean;
  /** The whole scene's first and last capture time, before any cut. */
  span: [number, number];
}

/** The photo's scene, cut to at most `max` frames around it: whole bursts nearest it first, or
 *  the frames nearest it when its own burst is longer than that. Null when the photo isn't in `frames`. */
export function sceneOf(
  targetId: string,
  frames: readonly SceneFrame[],
  vectors: Vectors = new Map(),
  max = SCENE_MAX_FRAMES,
): SceneAnswer | null {
  const scene = groupScenes(groupBursts(frames, vectors), frames, vectors).find((s) =>
    s.some((b) => b.includes(targetId)),
  );
  if (!scene) return null;
  const burst = scene.findIndex((b) => b.includes(targetId));
  const frame = scene[burst].indexOf(targetId);
  const atOf = new Map(frames.map((f) => [f.id, f.at]));
  const times = scene.flat().map((id) => atOf.get(id)!);
  const span: [number, number] = [Math.min(...times), Math.max(...times)];
  const total = times.length;
  if (total <= max) return { bursts: scene, burst, frame, truncated: false, span };
  const own = scene[burst];
  if (own.length >= max) {
    const from = Math.max(0, Math.min(frame - Math.floor(max / 2), own.length - max));
    return { bursts: [own.slice(from, from + max)], burst: 0, frame: frame - from, truncated: true, span };
  }
  let [lo, hi, size] = [burst, burst, own.length];
  // Outward one burst at a time, nearer side first, while it fits.
  for (;;) {
    const before = lo > 0 ? scene[lo - 1].length : Infinity;
    const after = hi < scene.length - 1 ? scene[hi + 1].length : Infinity;
    const take = before <= after ? before : after;
    if (size + take > max) break;
    size += take;
    if (before <= after) lo--;
    else hi++;
  }
  return { bursts: scene.slice(lo, hi + 1), burst: burst - lo, frame, truncated: true, span };
}
