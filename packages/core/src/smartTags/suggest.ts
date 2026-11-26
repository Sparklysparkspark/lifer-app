// Smart tag suggestions (docs/plans/smart-tags.md, ST-2): turns what Lifer already stores about a
// photo into vocabulary term ids. Pure: the background pass (apps/api/src/smartTags) loads the
// signals and the prompt vectors. Parents of a term are not suggestions; they come from its path
// (allPaths) when a tag is shown or written.
import {
  SMART_TAG_VOCAB,
  sunFits,
  timeMaybeWrong,
  trustedSun,
  type LightStats,
  type ShotFraming,
  type SmartTagGroup,
  type SmartTagTerm,
  type SmartTagVocab,
} from "@lifer/shared";
import defaultCalibrationJson from "./calibration.default.json" with { type: "json" };
import { meanUnit, parseVocabulary, scorePhoto, type VocabTerm } from "./clipScore.js";

/** Bump when a rule below changes, so every photo is evaluated again from stored data. */
export const SMART_TAG_ENGINE_VERSION = 1;

/** The calibration tool's output (calibrate-smart-tags), as far as the suggester reads it. */
export interface SmartTagCalibration {
  vocabVersion: string;
  imageModel: string;
  textModel: string;
  createdAt: string;
  terms: Array<{ id: string; threshold: number | null; validated: boolean }>;
}
// Fitted on catalog reference photos (iNaturalist-derived): stays in Lifer, never goes to Preen.
export const DEFAULT_SMART_TAG_CALIBRATION = defaultCalibrationJson as SmartTagCalibration;

export interface PhotoSignals {
  takenAt: Date | string | null;
  lat: number | string | null;
  lon: number | string | null;
  takenAtZoned: boolean | null;
  light: LightStats | null;
  /** Scene model shares in percent, null until the scene model has read the photo. */
  sceneLabels: Record<string, number> | null;
  sceneColors: Record<string, number> | null;
  /** Animals the detector counted; 0 or null says nothing. */
  subjectCount: number | null;
  hasSpecies: boolean;
  /** The Shot type framing (stats/shotKinds.ts), null without a vector or text model. */
  framing: ShotFraming | null;
  /** The stored whole-photo CLIP vector, null when the photo has none. */
  vector: ArrayLike<number> | null;
}

export type SuggestionSource = "computed" | "scene" | "clip";
export interface Suggestion {
  termId: string;
  score: number;
  source: SuggestionSource;
}

export interface SmartTagPlan {
  /** Identifies vocabulary, calibration, engine and models: a change re-evaluates every photo. */
  version: string;
  /** CLIP-based reading is possible (the text model is there). */
  clip: boolean;
  vocab: SmartTagVocab;
  groups: Map<string, SmartTagGroup>;
  terms: Map<string, SmartTagTerm>;
  /** Computed terms switched on in the vocabulary. */
  computed: Set<string>;
  /** CLIP and scene terms the calibration validated, with their thresholds. */
  active: Map<string, number>;
  /** What scorePhoto must see: active terms plus every sibling sharing their pick-one softmax. */
  scored: VocabTerm[];
  noneOf: Map<string, string[]>;
}

export interface ClipVectors {
  termVectors: Map<string, number[]>;
  noneVectors: Map<string, number[]>;
}

/** What to suggest under a vocabulary and calibration. CLIP terms stay off when the calibration was
 *  fitted for another vocabulary or model, or when the text model is missing (`clip` false). */
export function planSmartTags(opts: {
  imageModel: string;
  textModel: string;
  clip: boolean;
  vocab?: SmartTagVocab;
  calibration?: SmartTagCalibration;
}): SmartTagPlan {
  const vocab = opts.vocab ?? SMART_TAG_VOCAB;
  const cal = opts.calibration ?? DEFAULT_SMART_TAG_CALIBRATION;
  const fits =
    opts.clip &&
    cal.vocabVersion === String(vocab.version) &&
    cal.imageModel === opts.imageModel &&
    cal.textModel === opts.textModel;
  const parsed = parseVocabulary(vocab);
  const byId = new Map(parsed.terms.map((t) => [t.id, t]));
  const active = new Map<string, number>();
  if (fits)
    for (const c of cal.terms)
      if (c.validated && c.threshold != null && byId.get(c.id)?.prompts.length) active.set(c.id, c.threshold);
  const pickGroups = new Set([...active.keys()].map((id) => byId.get(id)!.pickOne).filter(Boolean));
  const scored = parsed.terms.filter(
    (t) => t.prompts.length > 0 && (active.has(t.id) || (t.pickOne && pickGroups.has(t.pickOne))),
  );
  const noneOf = new Map([...pickGroups].map((g) => [g!, parsed.none[g!] ?? []]));
  return {
    version: [
      `e${SMART_TAG_ENGINE_VERSION}`,
      `v${vocab.version}`,
      fits ? `c${cal.createdAt}` : "c-",
      opts.clip ? opts.textModel : "noclip",
    ].join("/"),
    clip: opts.clip,
    vocab,
    groups: new Map(vocab.groups.map((g) => [g.id, g])),
    terms: new Map(vocab.terms.map((t) => [t.id, t])),
    computed: new Set(vocab.terms.filter((t) => t.signal === "computed" && t.enabled).map((t) => t.id)),
    active,
    scored,
    noneOf,
  };
}

/** Every prompt the plan's CLIP terms and none options need, to embed once. */
export const planPrompts = (plan: SmartTagPlan): string[] => [
  ...new Set([...plan.scored.flatMap((t) => t.prompts), ...[...plan.noneOf.values()].flat()]),
];

/** Each term's and none option's prompts averaged, as the calibration tool does. */
export function bindClipVectors(plan: SmartTagPlan, vectorOf: (prompt: string) => ArrayLike<number>): ClipVectors {
  const mean = (prompts: string[]) => meanUnit(prompts.map(vectorOf));
  return {
    termVectors: new Map(plan.scored.map((t) => [t.id, mean(t.prompts)])),
    noneVectors: new Map([...plan.noneOf].filter(([, p]) => p.length).map(([g, p]) => [g, mean(p)])),
  };
}

// ---- Computed signals -----------------------------------------------------------------------

/** The time-of-day term from where the sun stood. Null in the blue-hour band and in a polar
 *  midnight sun, which no term describes. */
export function timeOfDayTerm(sun: { elevation: number; solarHour: number }): string | null {
  if (sunFits("night", sun)) return "time-of-day.night";
  if (sunFits("sunrise", sun)) return "time-of-day.around-sunrise";
  if (sunFits("sunset", sun)) return "time-of-day.around-sunset";
  if (sun.elevation < 0) return null;
  if (sunFits("morning", sun)) return "time-of-day.morning";
  if (sunFits("midday", sun)) return "time-of-day.midday";
  if (sunFits("afternoon", sun)) return "time-of-day.afternoon";
  return null;
}

// Between the tropics the four seasons don't apply.
const TROPIC_LAT = 23.44;
const NORTH_SEASON = [
  "winter",
  "winter",
  "spring",
  "spring",
  "spring",
  "summer",
  "summer",
  "summer",
  "autumn",
  "autumn",
  "autumn",
  "winter",
];
const FLIP: Record<string, string> = { winter: "summer", summer: "winter", spring: "autumn", autumn: "spring" };

/** Meteorological season from the local date and the hemisphere; null in the tropics. */
export function seasonTerm(at: Date, lat: number, lon: number): string | null {
  if (Math.abs(lat) < TROPIC_LAT) return null;
  // Local solar date, so a photo near midnight UTC lands in its own month.
  const month = new Date(at.getTime() + (lon / 15) * 3_600_000).getUTCMonth();
  const s = NORTH_SEASON[month];
  return `season.${lat >= 0 ? s : FLIP[s]}`;
}

// "Covers a large share of the frame": a colour on a quarter of the pixels or more.
export const COLOR_TERM_MIN_PERCENT = 25;
// Mean HSV saturation this low with only neutral colours is a monochrome photo.
const MONO_MAX_SATURATION = 0.04;
const NEUTRAL = new Set(["white", "black", "gray"]);
// The scene model's person class on this much of the frame: a person is in the photo.
export const PERSON_MIN_PERCENT = 3;
// Scene shares count from 5 percent of the frame (plan section (a)).
export const SCENE_TERM_MIN_PERCENT = 5;

const personShare = (p: PhotoSignals) => p.sceneLabels?.person ?? 0;
const sceneCoverage = (p: PhotoSignals, labels: string[]) =>
  labels.reduce((sum, l) => sum + (p.sceneLabels?.[l] ?? 0), 0);

function computedSuggestions(p: PhotoSignals): Suggestion[] {
  const out: Suggestion[] = [];
  const add = (termId: string | null, score = 1) => {
    if (termId) out.push({ termId, score, source: "computed" });
  };
  const sun = trustedSun({ taken_at: p.takenAt, lat: p.lat, lon: p.lon, taken_at_zoned: p.takenAtZoned });
  if (sun && !timeMaybeWrong(sun, p.light)) {
    add(timeOfDayTerm(sun));
    if (sunFits("goldenHour", sun)) add("light.golden-hour");
    if (sunFits("blueHour", sun)) add("light.blue-hour");
  }
  if (p.takenAt && p.lat != null && p.lon != null)
    add(seasonTerm(new Date(String(p.takenAt)), Number(p.lat), Number(p.lon)));
  if (p.sceneColors) {
    for (const [color, share] of Object.entries(p.sceneColors))
      if (share >= COLOR_TERM_MIN_PERCENT) add(`color.${color}-tones`, share / 100);
    const colors = Object.keys(p.sceneColors);
    if (p.light && p.light.saturation <= MONO_MAX_SATURATION && colors.length && colors.every((c) => NEUTRAL.has(c)))
      add("color.black-and-white");
  }
  if (p.framing) add(`composition.${p.framing}`);
  const n = p.subjectCount ?? 0;
  add(
    n === 2
      ? "composition.pair"
      : n >= 3 && n <= 9
        ? "composition.group"
        : n >= 10
          ? "composition.flock-or-herd"
          : null,
  );
  if (personShare(p) >= PERSON_MIN_PERCENT) add("people.people-in-photo", personShare(p) / 100);
  return out;
}

// ---- The suggester --------------------------------------------------------------------------

function gateOpen(group: SmartTagGroup | undefined, p: PhotoSignals): boolean {
  switch (group?.gate) {
    case "noSpecies":
      return !p.hasSpecies;
    // No animal-crop vector is stored, and computing one means reading the photo again.
    case "crop":
      return false;
    case "people":
      return personShare(p) >= PERSON_MIN_PERCENT;
    case "scene":
      return p.sceneLabels != null;
    default:
      return true;
  }
}

/** The suggested terms for one photo, capped per group, strongest first within a group. */
export function suggestSmartTags(p: PhotoSignals, plan: SmartTagPlan, vectors: ClipVectors | null): Suggestion[] {
  const termById = plan.terms;
  const all = computedSuggestions(p).filter((s) => plan.computed.has(s.termId));

  if (p.vector && vectors && plan.scored.length) {
    // Whole groups only, so a pick-one softmax sees the same members as in calibration.
    const terms = plan.scored.filter((t) => gateOpen(plan.groups.get(termById.get(t.id)!.group), p));
    const scores = terms.length ? scorePhoto(p.vector, terms, vectors.termVectors, vectors.noneVectors) : new Map();
    for (const [id, score] of scores) {
      const threshold = plan.active.get(id);
      if (threshold == null || score <= 0 || score < threshold) continue;
      const term = termById.get(id)!;
      if (term.signal === "scene") {
        // Scene shares first, CLIP to confirm (plan section (a)).
        const cover = sceneCoverage(p, term.scene ?? []);
        if (cover >= SCENE_TERM_MIN_PERCENT) all.push({ termId: id, score: cover / 100, source: "scene" });
      } else all.push({ termId: id, score, source: "clip" });
    }
  }

  const byGroup = new Map<string, Suggestion[]>();
  for (const s of all) {
    const g = termById.get(s.termId)!.group;
    byGroup.set(g, [...(byGroup.get(g) ?? []), s]);
  }
  return [...byGroup].flatMap(([g, list]) =>
    list.sort((a, b) => b.score - a.score).slice(0, plan.groups.get(g)?.cap ?? 1),
  );
}
