// Photo search ranking: runs a parsed query (photoSearch.ts) over the rows already filtered, with
// scene shares from the scene model and picture scores from CLIP. Shared with the phone; each
// side supplies its own PictureScorer (the hub embeds with its CLIP text encoder and reads image
// vectors from the database, the phone from its downloaded model and synced vectors).
import { speciesInGroup } from "./searchTaxonSynonyms.js";
import type { TimeOfDay } from "./sun.js";
import { compositionFits, lightAllows, sunDecides, type FrameBox, type LightStats } from "./photoFrame.js";
import {
  TIERS,
  TIER_RANK,
  STOPWORDS,
  sceneFilter,
  wordMatches,
  wordsOf,
  type CompositionReading,
  type CountFilter,
  type ParsedQuery,
  type Reading,
  type SceneFilter,
  type SearchPart,
} from "./searchTerms.js";

const TIMES_OF_DAY: TimeOfDay[] = [
  "goldenHour",
  "blueHour",
  "twilight",
  "sunrise",
  "sunset",
  "night",
  "morning",
  "midday",
  "afternoon",
  "evening",
];
// What CLIP looks for in photos with no coordinates to place the sun.
const COMPOSITION_READINGS: CompositionReading[] = [
  "ruleOfThirds",
  "goldenRatio",
  "centred",
  "smallInFrame",
  "frameFilling",
  "vertical",
  "horizontal",
];
const TIME_PROMPTS: Record<TimeOfDay, string> = {
  goldenHour: "warm golden hour light",
  blueHour: "blue hour twilight",
  twilight: "dusk twilight",
  sunrise: "sunrise",
  sunset: "sunset",
  night: "night",
  morning: "morning light",
  midday: "bright midday sun",
  afternoon: "afternoon light",
  evening: "evening light",
};

// A photo matches a description when it scores at least this much above its own noise level
// (see NOISE_PROMPTS) and is within reach of the best match. A per-photo baseline is needed
// because camera photos score much lower than reference photos against any prompt.
const CONTENT_MATCH_MIN = 0.033;
const CONTENT_MARGIN_RELATIVE = 0.55;

// The scene model reads blurred green backgrounds as water and grass as lake, so a photo it puts
// below this share also has to match by picture (CLIP) to count.
const SCENE_SURE_PERCENT = 50;
// The picture match such a photo needs: well below a picture-only match (CONTENT_MATCH_MIN),
// since the scene model already found some of it. A moose beside a pond clears it; a green
// blur read as water doesn't.
const SCENE_CONFIRM_MIN = 0.015;

/** How much of a photo one filter covers, or null when it falls short. */
function filterShare(row: SearchRow, s: SceneFilter): number | null {
  const share =
    "color" in s
      ? (row.scene_colors?.[s.color] ?? 0)
      : s.labels.reduce((sum, l) => sum + (row.scene_labels?.[l] ?? 0), 0);
  return share >= s.min ? share : null;
}

/** How much of a photo its scene filters cover together, or null when one falls short. */
function sceneCoverage(row: SearchRow, scenes: SceneFilter[]): number | null {
  let total = 0;
  for (const s of scenes) {
    const shares = [s, ...(s.alternatives ?? [])].map((f) => filterShare(row, f)).filter((x) => x !== null);
    if (shares.length === 0) {
      if (s.orSpecies?.includes(row.species_id)) continue;
      return null;
    }
    total += Math.max(...shares);
  }
  return total;
}

// "a photo of water" asks for a picture OF water; in a wildlife library "water" usually means an
// animal in or by it, so the phrasings include that reading too.
export const QUERY_TEMPLATES = (d: string) => [
  `a photo of ${d}`,
  `a wildlife photo with ${d}`,
  `a photo of an animal in ${d}`,
  `a photo of an animal near ${d}`,
  `a wildlife photo of ${d}`,
  d,
];
// Things never in a wildlife photo. A photo's average match to these is its noise level: how
// much it matches ANY prompt just by being a wildlife photo, which differs from photo to photo.
export const NOISE_PROMPTS = [
  "a car",
  "a city street",
  "text on a page",
  "food on a plate",
  "a building",
  "a computer",
  "furniture",
  "a cartoon",
  "an airplane",
  "a spreadsheet",
  "a company logo",
  "a keyboard",
];
/** A description's query vector from its templates' text vectors. */
export function combineQueryVectors(parts: Float32Array[]): Float32Array {
  const v = new Float32Array(parts[0].length);
  for (const p of parts) for (let i = 0; i < v.length; i++) v[i] += p[i];
  return normalizeVector(v);
}

/** The average of the noise prompts' query vectors: a photo's dot product with it is its average
 *  match to them. */
export function averageVectors(vs: Float32Array[]): Float32Array {
  const avg = new Float32Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < avg.length; i++) avg[i] += v[i] / vs.length;
  return avg;
}

export function normalizeVector(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function dotVectors(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Picture matching for one side: each row's CLIP match to a description above its own noise
 *  level (null for a row with no image vector), or null without the text model. */
export type PictureScorer = (text: string, rows: SearchRow[]) => Promise<Array<number | null> | null>;

/** A scorer from a text embedder (one vector per text) and a lookup of image vectors by capture. */
export function makePictureScorer(
  embedTexts: (texts: string[]) => Promise<Float32Array[]>,
  imageVectors: (rows: SearchRow[]) => Promise<Map<string, ArrayLike<number>>>,
): PictureScorer {
  const cache = new Map<string, Float32Array>();
  const queryVector = async (text: string) => {
    const hit = cache.get(text);
    if (hit) return hit;
    const v = combineQueryVectors(await embedTexts(QUERY_TEMPLATES(text)));
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
    cache.set(text, v);
    return v;
  };
  let noise: Promise<Float32Array> | null = null;
  const noiseVector = () => {
    noise ??= Promise.all(NOISE_PROMPTS.map(queryVector)).then(averageVectors);
    noise.catch(() => (noise = null));
    return noise;
  };
  return async (text, rows) => {
    // Species matching isn't downloaded: names, groups, places and dates still work.
    const vecs = await Promise.all([queryVector(text), noiseVector()]).catch(() => null);
    if (!vecs) return null;
    const [queryVec, noiseVec] = vecs;
    const vectors = await imageVectors(rows);
    return rows.map((row) => {
      const v = vectors.get(row.capture_id);
      return v ? dotVectors(v, queryVec) - dotVectors(v, noiseVec) : null;
    });
  };
}

export interface SearchRow {
  capture_id: string;
  species_id: string;
  quality_rating: number | null;
  taken_at: Date | string | null;
  tags: string[] | null;
  region_id: string | null;
  location_label: string | null;
  trip_id?: string | null;
  album_ids?: string[] | null;
  focal_length_mm: number | string | null;
  embedding_computed_at: string | null;
  common_name: string | null;
  scientific_name: string;
  taxon_class: string | null;
  taxon_order: string | null;
  family: string | null;
  /** Scene model shares (percent of the photo), null until the scene model has read the photo. */
  scene_labels?: Record<string, number> | null;
  scene_colors?: Record<string, number> | null;
  /** Animals the detector found, null until counted. */
  subject_count?: number | null;
  /** The species' rarity tier, the user's own first. */
  tier?: string | null;
  /** The species' first photo (its taken_at is the species' first_collected). */
  is_lifer?: boolean;
  is_endemic?: boolean;
  camera_model?: string | null;
  lat?: number | string | null;
  lon?: number | string | null;
  /** False when the file gave no time zone, so the sun can't be placed from the time. */
  taken_at_zoned?: boolean | null;
  /** The detector's subject box (fractions of the upright photo), null when it found none or
   *  hasn't read the photo yet (frame_aspect null too). */
  frame_box?: number[] | null;
  frame_unsure?: boolean | null;
  frame_aspect?: number | null;
  light_stats?: LightStats | null;
  [key: string]: unknown;
}

/** A photo's animal count when the detector found any. Zero means it found nothing it knows
 *  (an insect, a frog), not that the photo is empty, so it's left to CLIP like an uncounted one. */
function knownCount(row: SearchRow): number | null {
  return row.subject_count ? row.subject_count : null;
}

function countFits(count: number, c: Pick<CountFilter, "min" | "max">): boolean {
  return count >= c.min && (c.max === null || count <= c.max);
}

export interface SearchOutcome<R> {
  items: Array<{ row: R; score: number | null }>;
  interpretation: ParsedQuery["labels"] & {
    /** The query's parts; a light part is exact only when every photo kept was placed by the sun. */
    parts?: SearchPart[];
    backgrounds?: string[];
    description: string | null;
    count: Pick<CountFilter, "min" | "max" | "about" | "crowd"> | null;
    stars: ParsedQuery["stars"];
  };
  /** A quick answer that skipped picture matching: the full one is still to come. */
  pending?: boolean;
}

function byRatingThenDate(a: SearchRow, b: SearchRow): number {
  return (
    (b.quality_rating ?? 0) - (a.quality_rating ?? 0) ||
    new Date(String(b.taken_at ?? 0)).getTime() - new Date(String(a.taken_at ?? 0)).getTime()
  );
}

function tagMatches(tags: string[] | null, query: string): boolean {
  const qWords = wordsOf(query).filter((w) => !STOPWORDS.has(w));
  if (qWords.length === 0) return false;
  const joined = ` ${qWords.join(" ")} `;
  return (tags ?? []).some((t) => {
    const tw = wordsOf(t);
    if (tw.length === 0) return false;
    // The tag names the query ("yellow flower" tagged on a photo), or the query names the tag.
    return (
      qWords.every((w) => tw.some((x) => wordMatches(x, w))) ||
      (tw.join(" ").length >= 3 && joined.includes(` ${tw.join(" ")} `))
    );
  });
}

/** Each row's CLIP match to a description above its own noise level, or null without the model. */
async function pictureScores<R extends SearchRow>(
  score: PictureScorer,
  text: string,
  rows: R[],
): Promise<Array<{ row: R; score: number | null }> | null> {
  const scores = await score(text, rows);
  return scores && rows.map((row, i) => ({ row, score: scores[i] }));
}

/** The score a clear match needs: a minimum, and within reach of the best. */
function matchCutoff(scored: Array<{ score: number | null }>): number {
  const top = Math.max(0, ...scored.map((s) => s.score ?? 0));
  return Math.max(CONTENT_MATCH_MIN, top * CONTENT_MARGIN_RELATIVE);
}

/** The rows CLIP clearly matches to `prompt`, or null without the model. Scored with every row
 *  so the cutoff is set by real matches. */
async function clearMatches(score: PictureScorer, prompt: string, rows: SearchRow[]): Promise<Set<string> | null> {
  const scored = await pictureScores(score, prompt, rows);
  if (!scored) return null;
  const cutoff = matchCutoff(scored);
  return new Set(scored.filter((s) => (s.score ?? -1) >= cutoff).map((s) => s.row.capture_id));
}

/** Keeps the rows a stored fact says yes to, and leaves the ones it can't decide (null) to CLIP's
 *  reading of `prompt`. Without the picture model, `undecidedStay` picks which undecided rows stay. */
async function keepByFactOrPicture<R extends SearchRow>(
  score: PictureScorer,
  rows: R[],
  judge: (r: R) => boolean | null,
  prompt: string,
  quick: boolean,
  undecidedStay: (r: R) => boolean = () => true,
  /** A picture match this says no to doesn't count (the photo's own light can't be dusk). */
  pictureOk: (r: R) => boolean = () => true,
): Promise<{ rows: R[]; pending: boolean }> {
  const undecided = rows.filter((r) => judge(r) === null);
  if (undecided.length === 0) return { rows: rows.filter((r) => judge(r)), pending: false };
  if (quick) return { rows: rows.filter((r) => judge(r)), pending: true };
  const matched = await clearMatches(score, prompt, rows);
  return {
    rows: rows.filter(
      (r) =>
        judge(r) || (judge(r) === null && (matched ? matched.has(r.capture_id) && pictureOk(r) : undecidedStay(r))),
    ),
    pending: false,
  };
}

/** The stored frame of a photo: its subject box, and its shape from the frame or the photo size. */
function frameOf(r: SearchRow): { box: FrameBox | null; unsure: boolean; aspect: number | null } {
  const w = Number(r.width);
  const h = Number(r.height);
  return {
    box: r.frame_box?.length === 4 ? (r.frame_box as FrameBox) : null,
    unsure: !!r.frame_unsure,
    aspect: r.frame_aspect ?? (w > 0 && h > 0 ? w / h : null),
  };
}

/** Runs a parsed query over the rows the route already filtered (rating, taxa, dates...). */
export async function rankSearch<R extends SearchRow>(
  q: string,
  parsed: ParsedQuery,
  rows: R[],
  regionSubtree: (regionIds: string[]) => Promise<Set<string>>,
  score: PictureScorer,
  /** `backgroundScore` reads the photos' background vectors ("tree in the background"); without
   *  it, or for a photo with none, the whole photo is read instead. */
  opts: { quick?: boolean; backgroundScore?: PictureScorer } = {},
): Promise<SearchOutcome<R>> {
  const count = parsed.count;
  const backgrounds = parsed.backgrounds ?? [];
  const interpretation = {
    ...parsed.labels,
    ...(parsed.parts ? { parts: parsed.parts.map((p) => ({ ...p })) } : {}),
    ...(backgrounds.length > 0 ? { backgrounds } : {}),
    description: parsed.description,
    count: count && { min: count.min, max: count.max, about: count.about, crowd: count.crowd },
    stars: parsed.stars,
  };
  const reads = (r: Reading) => parsed.readings.has(r);
  let candidates = rows;
  if (reads("lifers")) candidates = candidates.filter((r) => r.is_lifer);
  const tiers: string[] = TIERS.filter(reads);
  if (tiers.length) candidates = candidates.filter((r) => r.tier && tiers.includes(r.tier));
  if (reads("endemic")) candidates = candidates.filter((r) => r.is_endemic);
  if (reads("noLocation")) candidates = candidates.filter((r) => !r.region_id);
  if (parsed.cameras.length > 0) candidates = candidates.filter((r) => parsed.cameras.includes(r.camera_model ?? ""));
  if (parsed.excludeSpeciesIds.size > 0 || parsed.excludeGroups.length > 0) {
    candidates = candidates.filter(
      (r) =>
        !parsed.excludeSpeciesIds.has(r.species_id) &&
        !parsed.excludeGroups.some((g) =>
          speciesInGroup(
            { taxonClass: r.taxon_class, taxonOrder: r.taxon_order, family: r.family, commonName: r.common_name },
            g.predicate,
          ),
        ),
    );
  }

  // Composition words keep photos whose stored subject box fits. A photo with no sure box can't be
  // told, so it's left out: placement is exact or not shown.
  for (const c of COMPOSITION_READINGS.filter(reads))
    candidates = candidates.filter((r) => compositionFits(c, frameOf(r)));

  if (parsed.focalLengthMm) {
    const target = parsed.focalLengthMm;
    candidates = candidates.filter(
      (r) => r.focal_length_mm != null && Math.abs(Number(r.focal_length_mm) - target) <= target * 0.2,
    );
  }
  if (parsed.places.length > 0) {
    const regionIds = parsed.places.filter((p) => p.kind === "region").map((p) => p.id);
    const inRegion = regionIds.length > 0 ? await regionSubtree(regionIds) : new Set<string>();
    const labels = new Set(parsed.places.filter((p) => p.kind === "location").map((p) => p.name.toLowerCase()));
    const trips = new Set(parsed.places.filter((p) => p.kind === "trip").map((p) => p.id));
    const albums = new Set(parsed.places.filter((p) => p.kind === "album").map((p) => p.id));
    candidates = candidates.filter(
      (r) =>
        (r.region_id && inRegion.has(r.region_id)) ||
        (r.location_label && labels.has(r.location_label.toLowerCase())) ||
        (r.trip_id && trips.has(r.trip_id)) ||
        (r.album_ids ?? []).some((a) => albums.has(a)),
    );
  }
  if (parsed.years.length > 0 || parsed.months.length > 0 || parsed.dateRanges.length > 0) {
    candidates = candidates.filter((r) => {
      if (!r.taken_at) return false;
      const d = new Date(String(r.taken_at));
      return (
        (parsed.years.length === 0 || parsed.years.includes(d.getFullYear())) &&
        (parsed.months.length === 0 || parsed.months.includes(d.getMonth() + 1)) &&
        (parsed.dateRanges.length === 0 || parsed.dateRanges.some((x) => d >= x.from && d < x.to))
      );
    });
  }

  const tagged = new Set(candidates.filter((r) => tagMatches(r.tags, q)).map((r) => r.capture_id));
  const hasSubject = parsed.speciesIds !== null || parsed.groups.length > 0;
  if (hasSubject) {
    candidates = candidates.filter(
      (r) =>
        tagged.has(r.capture_id) ||
        parsed.speciesIds?.has(r.species_id) ||
        parsed.groups.some((g) =>
          speciesInGroup(
            { taxonClass: r.taxon_class, taxonOrder: r.taxon_order, family: r.family, commonName: r.common_name },
            g.predicate,
          ),
        ),
    );
  }

  // A count keeps photos with that many animals. Crowds, and photos not counted yet, are judged by
  // CLIP instead: the detector misses small distant birds, and the count backfill takes a while.
  let awaitsPicture = false;
  const quick = opts.quick ?? false;
  if (count) {
    const kept = await keepByFactOrPicture(
      score,
      candidates,
      (r) => {
        const n = knownCount(r);
        if (tagged.has(r.capture_id) || (n !== null && countFits(n, count))) return true;
        return count.crowd || n === null ? null : false;
      },
      count.prompt,
      quick,
      // No picture model: uncounted photos stay rather than vanish.
      (r) => knownCount(r) === null,
    );
    candidates = kept.rows;
    awaitsPicture ||= kept.pending;
  }
  // A time of day is read from where the sun was. Photos with no place, no time zone, or light that
  // says their time is wrong go by the picture, with their own light able to veto it.
  const timeOfDay = TIMES_OF_DAY.find(reads);
  if (timeOfDay) {
    const kept = await keepByFactOrPicture(
      score,
      candidates,
      (r) => sunDecides(timeOfDay, r),
      TIME_PROMPTS[timeOfDay],
      quick,
      undefined,
      (r) => lightAllows(timeOfDay, r.light_stats),
    );
    candidates = kept.rows;
    awaitsPicture ||= kept.pending;
    if (candidates.some((r) => sunDecides(timeOfDay, r) === null))
      for (const p of interpretation.parts ?? []) if (p.kind === "light") p.exact = false;
  }
  // "without people": photos that clearly show it go.
  for (const phrase of parsed.excludeDescriptions) {
    if (quick) {
      awaitsPicture = true;
      break;
    }
    const shown = await clearMatches(score, phrase, candidates);
    if (shown) candidates = candidates.filter((r) => !shown.has(r.capture_id));
  }
  // "black and white" alone: photos of black-and-white animals, below the monochrome ones.
  const colorOk = (r: SearchRow) => !!parsed.colorHint?.every((c) => filterShare(r, sceneFilter(c)!) !== null);
  const colorHinted = (scored: Array<{ row: R; score: number | null }>, kept: Array<{ row: R }>) => {
    const keptIds = new Set(kept.map((k) => k.row.capture_id));
    return scored.filter((s) => colorOk(s.row) && !keptIds.has(s.row.capture_id));
  };
  const hintOk = (r: SearchRow) =>
    parsed.hintSpeciesIds.has(r.species_id) &&
    (parsed.hintMinCount === null || (knownCount(r) ?? 0) >= parsed.hintMinCount);

  // Scene words keep photos covered enough by each, most covered first. Photos the scene model
  // hasn't read yet are judged by CLIP instead, so search works before the backfill finishes.
  const coverage = new Map<string, number>();
  const hasScene = parsed.scenes.length > 0;
  if (hasScene) {
    const unread = candidates.filter((r) => !r.scene_labels);
    for (const r of candidates) {
      const c = r.scene_labels ? sceneCoverage(r, parsed.scenes) : null;
      if (c !== null) coverage.set(r.capture_id, c);
    }
    // Colours are measured from the pixels and hold up; only scene labels need the second look.
    const readsLabels = parsed.scenes.some((sc) => "labels" in sc || sc.alternatives?.some((a) => "labels" in a));
    const unsure = (id: string) => readsLabels && (coverage.get(id) ?? 0) < SCENE_SURE_PERCENT;
    const borderline = candidates.filter((r) => coverage.has(r.capture_id) && unsure(r.capture_id));
    const judged = new Set<string>();
    // null: no picture model, so the scene model's reading stands alone.
    let checked: Set<string> | null = null;
    if ((unread.length > 0 || borderline.length > 0) && opts.quick) awaitsPicture = true;
    else if (unread.length > 0 || borderline.length > 0) {
      // Scored with the sure photos too, so the cutoff is set by real matches.
      const read = candidates.filter((r) => coverage.has(r.capture_id));
      // Read photos are checked against the plain scene ("water"), not the word typed: the picture
      // model ties "pond" to ducks, so it would pass any duck photo.
      const plain = parsed.scenes.map((sc) => ("labels" in sc ? sc.labels[0] : sc.label)).join(" ");
      const [unreadScores, readScores] = await Promise.all([
        unread.length > 0 ? pictureScores(score, parsed.labels.scenes.join(" "), unread) : Promise.resolve([]),
        pictureScores(score, plain, read),
      ]);
      const scored = unreadScores && readScores ? [...unreadScores, ...readScores] : null;
      if (scored) {
        checked = new Set(borderline.map((r) => r.capture_id));
        const cutoff = matchCutoff(scored);
        // A photo with no picture vector can't be checked, so its scene reading stands.
        for (const s of scored) {
          const wasRead = coverage.has(s.row.capture_id);
          if (s.score === null ? wasRead : s.score >= (wasRead ? SCENE_CONFIRM_MIN : cutoff))
            judged.add(s.row.capture_id);
        }
      }
    }
    candidates = candidates.filter(
      (r) =>
        (coverage.has(r.capture_id) &&
          !(checked?.has(r.capture_id) && !judged.has(r.capture_id)) &&
          // The quick pass shows only sure photos; the full one adds the confirmed in-between ones.
          !(awaitsPicture && unsure(r.capture_id))) ||
        judged.has(r.capture_id) ||
        tagged.has(r.capture_id) ||
        parsed.scenes.every((s) => s.orSpecies?.includes(r.species_id)),
    );
  }
  const filtered = hasSubject || hasScene || !!count;
  // Asked for something beyond the picture, so the filters alone are an answer.
  const narrowed =
    filtered ||
    parsed.places.length > 0 ||
    parsed.years.length > 0 ||
    parsed.months.length > 0 ||
    parsed.dateRanges.length > 0 ||
    parsed.bestFirst ||
    !!parsed.focalLengthMm ||
    parsed.readings.size > 0 ||
    !!parsed.stars ||
    parsed.cameras.length > 0 ||
    parsed.labels.excluded.length > 0;
  // Unrated counts as 3 stars, like the Sort menu.
  const byBest = (a: SearchRow, b: SearchRow) =>
    parsed.bestFirst ? (b.quality_rating ?? 3) - (a.quality_rating ?? 3) : 0;
  const byFit = (a: SearchRow, b: SearchRow) =>
    byBest(a, b) || (coverage.get(b.capture_id) ?? 0) - (coverage.get(a.capture_id) ?? 0) || byRatingThenDate(a, b);
  const byScore = (a: { row: R; score: number | null }, b: { row: R; score: number | null }) =>
    byBest(a.row, b.row) || (b.score ?? -1) - (a.score ?? -1);

  const withTagsFirst = (scored: Array<{ row: R; score: number | null }>) => {
    // No cap: the gallery shows every photo, and picture-only searches are already cut by margin.
    const items = [
      ...scored.filter((s) => tagged.has(s.row.capture_id)),
      ...scored.filter((s) => !tagged.has(s.row.capture_id)),
    ];
    if (reads("rarestFirst"))
      items.sort((a, b) => (TIER_RANK[b.row.tier ?? ""] ?? 0) - (TIER_RANK[a.row.tier ?? ""] ?? 0));
    // "latest owl": the newest (or oldest) photo first, the rest in their order below it.
    const newest = reads("newestFirst");
    if (newest || reads("oldestFirst")) {
      const time = (s: { row: R }) => (s.row.taken_at ? new Date(String(s.row.taken_at)).getTime() : null);
      let pick = -1;
      items.forEach((s, k) => {
        const t = time(s);
        const best = pick >= 0 ? time(items[pick])! : null;
        if (t !== null && (best === null || (newest ? t > best : t < best))) pick = k;
      });
      if (pick > 0) items.unshift(...items.splice(pick, 1));
    }
    return items;
  };

  // Nothing about the picture: the filters are the answer.
  if (!parsed.description && backgrounds.length === 0) {
    if (!narrowed) {
      return {
        items: withTagsFirst(rows.filter((r) => tagged.has(r.capture_id)).map((row) => ({ row, score: null }))),
        interpretation,
      };
    }
    const sorted = [...candidates].sort(
      parsed.focalLengthMm
        ? (a, b) =>
            byBest(a, b) ||
            Math.abs(Number(a.focal_length_mm) - parsed.focalLengthMm!) -
              Math.abs(Number(b.focal_length_mm) - parsed.focalLengthMm!)
        : byFit,
    );
    const items = withTagsFirst(sorted.map((row) => ({ row, score: null })));
    return awaitsPicture ? { items, interpretation, pending: true } : { items, interpretation };
  }

  // The quick pass skips picture matching: it shows a subject's or scene's photos right away, or
  // nothing for a description-only query so the page keeps what it had.
  if (opts.quick) {
    const quickItems = narrowed ? [...candidates].sort(byFit).map((row) => ({ row, score: null })) : [];
    return { items: withTagsFirst(quickItems), interpretation, pending: true };
  }

  const scored = await fuzzyScores(score, opts.backgroundScore, parsed.description, backgrounds, candidates);
  if (!scored) {
    const fallback = narrowed
      ? [...candidates].sort(byFit)
      : candidates.filter((r) => tagged.has(r.capture_id) || hintOk(r) || colorOk(r));
    return { items: withTagsFirst(fallback.map((row) => ({ row, score: null }))), interpretation };
  }

  // Subject or scene plus description: every photo of it, best fit first. Never hides one.
  if (narrowed) {
    scored.sort((a, b) => byScore(a, b) || byFit(a.row, b.row));
    return { items: withTagsFirst(scored), interpretation };
  }

  // Only a description: keep clear matches, plus photos of species whose names share its words
  // (Northern Flying Squirrel for "flying") and photos tagged with it.
  const cutoff = matchCutoff(scored);
  // A describing word in species names could mean either. If most photos of those species also
  // match it by picture, treat it as naming them and show just them.
  const hinted = scored.filter((s) => hintOk(s.row));
  if (hinted.length > 0 && hinted.filter((s) => (s.score ?? -1) >= cutoff).length >= hinted.length / 2) {
    hinted.sort(byScore);
    const taggedRows = scored.filter((s) => tagged.has(s.row.capture_id) && !hintOk(s.row));
    return {
      items: withTagsFirst([...hinted, ...taggedRows]),
      interpretation: {
        ...interpretation,
        species: [...new Set(hinted.map((s) => s.row.common_name ?? s.row.scientific_name))],
      },
    };
  }
  const kept = scored.filter((s) => (s.score ?? -1) >= cutoff || hintOk(s.row) || tagged.has(s.row.capture_id));
  kept.sort(byScore);
  return { items: withTagsFirst([...kept, ...colorHinted(scored, kept)]), interpretation };
}

/** Each row's picture score: its match to the description plus, for each background asked for, its
 *  background vector's match (the whole photo's for a row with none). Null without the model. */
async function fuzzyScores<R extends SearchRow>(
  score: PictureScorer,
  backgroundScore: PictureScorer | undefined,
  description: string | null,
  backgrounds: string[],
  rows: R[],
): Promise<Array<{ row: R; score: number | null }> | null> {
  const scored = description
    ? await pictureScores(score, description, rows)
    : rows.map((row) => ({ row, score: null }));
  if (!scored) return null;
  for (const b of backgrounds) {
    const behind = backgroundScore ? await backgroundScore(b, rows) : null;
    const rest = rows.filter((_, i) => behind?.[i] == null);
    const whole = rest.length > 0 ? await score(`${b} in the background`, rest) : [];
    if (!behind && !whole) return null;
    const wholeById = new Map(rest.map((r, i) => [r.capture_id, whole?.[i] ?? null]));
    scored.forEach((s, i) => {
      const v = behind?.[i] ?? wholeById.get(s.row.capture_id) ?? null;
      if (v !== null) s.score = (s.score ?? 0) + v;
    });
  }
  return scored;
}
