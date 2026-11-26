import { describe, expect, it } from "vitest";
import { SMART_TAG_VOCAB, type SmartTagGroup, type SmartTagTerm, type SmartTagVocab } from "@lifer/shared";
import {
  bindClipVectors,
  DEFAULT_SMART_TAG_CALIBRATION,
  planPrompts,
  planSmartTags,
  seasonTerm,
  suggestSmartTags,
  timeOfDayTerm,
  type PhotoSignals,
  type SmartTagCalibration,
} from "./suggest.js";

const MODELS = { imageModel: "img-1", textModel: "txt-1" };
const base: PhotoSignals = {
  takenAt: null,
  lat: null,
  lon: null,
  takenAtZoned: true,
  light: null,
  sceneLabels: null,
  sceneColors: null,
  subjectCount: null,
  hasSpecies: true,
  framing: null,
  vector: null,
};
const realPlan = planSmartTags({ ...MODELS, clip: false });
const ids = (p: Partial<PhotoSignals>, plan = realPlan) =>
  suggestSmartTags({ ...base, ...p }, plan, null)
    .map((s) => s.termId)
    .sort();

describe("season", () => {
  it("follows the hemisphere", () => {
    const july = new Date("2026-07-15T12:00:00Z");
    expect(seasonTerm(july, 52, 0)).toBe("season.summer");
    expect(seasonTerm(july, -34, 150)).toBe("season.winter");
    expect(seasonTerm(new Date("2026-04-10T12:00:00Z"), -40, 175)).toBe("season.autumn");
    expect(seasonTerm(new Date("2026-10-10T12:00:00Z"), -40, 175)).toBe("season.spring");
  });
  it("has none between the tropics", () => {
    expect(seasonTerm(new Date("2026-07-15T12:00:00Z"), 10, 0)).toBeNull();
    expect(seasonTerm(new Date("2026-07-15T12:00:00Z"), -23, 0)).toBeNull();
  });
  it("uses the local date at a month boundary", () => {
    // 23:00 UTC on 28 February is already 1 March in New Zealand.
    expect(seasonTerm(new Date("2026-02-28T23:00:00Z"), -41, 175)).toBe("season.autumn");
    expect(seasonTerm(new Date("2026-02-28T23:00:00Z"), 51, -1)).toBe("season.winter");
  });
});

describe("time of day", () => {
  it("reads the sun's position", () => {
    expect(timeOfDayTerm({ elevation: 60, solarHour: 12 })).toBe("time-of-day.midday");
    expect(timeOfDayTerm({ elevation: 30, solarHour: 9 })).toBe("time-of-day.morning");
    expect(timeOfDayTerm({ elevation: 30, solarHour: 15 })).toBe("time-of-day.afternoon");
    expect(timeOfDayTerm({ elevation: 2, solarHour: 7 })).toBe("time-of-day.around-sunrise");
    expect(timeOfDayTerm({ elevation: 2, solarHour: 18 })).toBe("time-of-day.around-sunset");
    expect(timeOfDayTerm({ elevation: -20, solarHour: 0 })).toBe("time-of-day.night");
    // Blue-hour band: no time term, only the light term.
    expect(timeOfDayTerm({ elevation: -5, solarHour: 19 })).toBeNull();
  });
  it("calls polar noon in December night, and leaves a high midnight sun unnamed", () => {
    // Longyearbyen at local solar noon in midwinter: the sun stays about 12 degrees below the horizon.
    expect(ids({ takenAt: "2026-12-21T11:00:00Z", lat: 78.22, lon: 15.65 })).toContain("time-of-day.night");
    // Tromso at the same moment is in noon twilight, not night.
    expect(ids({ takenAt: "2026-12-21T10:50:00Z", lat: 69.65, lon: 18.96 })).not.toContain("time-of-day.night");
    // Svalbard at solar midnight in midsummer: the sun is about 11 degrees up.
    const svalbard = ids({ takenAt: "2026-06-21T23:00:00Z", lat: 78.22, lon: 15.65 });
    expect(svalbard.filter((t) => t.startsWith("time-of-day."))).toEqual([]);
    expect(svalbard).toContain("season.summer");
  });
  it("needs GPS and a trusted time zone", () => {
    expect(ids({ takenAt: "2026-06-01T12:00:00Z" })).toEqual([]);
    const unzoned = ids({ takenAt: "2026-06-01T12:00:00Z", lat: 51.5, lon: 0, takenAtZoned: false });
    expect(unzoned).toEqual(["season.summer"]);
  });
  it("adds golden hour beside the sunrise term", () => {
    // London, 21 June, a few minutes after sunrise (about 03:43 UTC).
    expect(ids({ takenAt: "2026-06-21T04:00:00Z", lat: 51.5, lon: -0.1 })).toEqual([
      "light.golden-hour",
      "season.summer",
      "time-of-day.around-sunrise",
    ]);
  });
});

describe("computed signals", () => {
  it("names up to two dominant colours, strongest first", () => {
    const s = suggestSmartTags({ ...base, sceneColors: { green: 30, blue: 60, brown: 26, white: 5 } }, realPlan, null);
    expect(s.map((x) => x.termId)).toEqual(["color.blue-tones", "color.green-tones"]);
    expect(s[0].score).toBeCloseTo(0.6);
  });
  it("calls a desaturated, neutral photo black and white", () => {
    const light = { luma: 0.4, warmth: 0, highlights: 0.1, shadows: 0.1, saturation: 0.01 };
    expect(ids({ sceneColors: { gray: 70, black: 20, white: 10 }, light })).toContain("color.black-and-white");
    expect(ids({ sceneColors: { gray: 70, black: 20, blue: 10 }, light })).not.toContain("color.black-and-white");
    expect(ids({ sceneColors: { gray: 90 }, light: { ...light, saturation: 0.2 } })).not.toContain(
      "color.black-and-white",
    );
  });
  it("reads group size from the detector count", () => {
    expect(ids({ subjectCount: 1 })).toEqual([]);
    expect(ids({ subjectCount: 2 })).toEqual(["composition.pair"]);
    expect(ids({ subjectCount: 9 })).toEqual(["composition.group"]);
    expect(ids({ subjectCount: 40 })).toEqual(["composition.flock-or-herd"]);
  });
  it("reads framing and people presence", () => {
    expect(ids({ framing: "close" })).toEqual(["composition.close"]);
    expect(ids({ sceneLabels: { person: 12, tree: 40 } })).toEqual(["people.people-in-photo"]);
    expect(ids({ sceneLabels: { person: 2 } })).toEqual([]);
  });
});

// A small vocabulary on 3-d vectors: x is "bird", y is "mammal", z the none option.
const group = (g: Partial<SmartTagGroup> & { id: string }): SmartTagGroup => ({
  root: g.id[0].toUpperCase() + g.id.slice(1),
  kind: "many",
  cap: 2,
  none: false,
  ...g,
});
const term = (id: string, groupId: string, prompts: string[], extra: Partial<SmartTagTerm> = {}): SmartTagTerm => ({
  id,
  path: `${groupId[0].toUpperCase() + groupId.slice(1)}|${id}`,
  name: id,
  usage: "test term with a long enough usage",
  synonyms: [],
  prompts,
  signal: "clip",
  group: groupId,
  unvalidated: true,
  enabled: false,
  ...extra,
});
const toyVocab: SmartTagVocab = {
  version: 9,
  groups: [
    {
      ...group({ id: "subject", kind: "pick-one", cap: 1, none: true, gate: "noSpecies" }),
      nonePrompts: ["none"],
    } as SmartTagGroup,
    group({ id: "things", cap: 2 }),
    group({ id: "activities", gate: "people" }),
    group({ id: "habitat", gate: "scene" }),
    group({ id: "behaviour", gate: "crop" }),
  ],
  terms: [
    term("bird", "subject", ["bird"]),
    term("mammal", "subject", ["mammal"]),
    term("a", "things", ["x"]),
    term("b", "things", ["y"]),
    term("c", "things", ["z"]),
    term("hike", "activities", ["x"]),
    term("wet", "habitat", ["x"], { signal: "scene", scene: ["water"] }),
    term("fly", "behaviour", ["x"]),
  ],
};
const VEC: Record<string, number[]> = {
  bird: [1, 0, 0],
  mammal: [0, 1, 0],
  none: [0, 0, 1],
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};
const cal = (terms: Record<string, number>, over: Partial<SmartTagCalibration> = {}): SmartTagCalibration => ({
  vocabVersion: "9",
  ...MODELS,
  createdAt: "t1",
  terms: Object.entries(terms).map(([id, threshold]) => ({ id, threshold, validated: true })),
  ...over,
});
function toy(calibration: SmartTagCalibration) {
  const plan = planSmartTags({ ...MODELS, clip: true, vocab: toyVocab, calibration });
  return { plan, vectors: bindClipVectors(plan, (p) => VEC[p]) };
}
const unit = (v: number[]) => v.map((x) => x / Math.hypot(...v));

describe("CLIP terms", () => {
  it("pick-one: the winner over the none option, at its threshold", () => {
    const { plan, vectors } = toy(cal({ bird: 0.5 }));
    // The unvalidated sibling still takes part in the softmax, as in calibration.
    expect(plan.scored.map((t) => t.id).sort()).toEqual(["bird", "mammal"]);
    expect(planPrompts(plan).sort()).toEqual(["bird", "mammal", "none"]);
    const p = { ...base, hasSpecies: false };
    const bird = suggestSmartTags({ ...p, vector: unit([1, 0.02, 0]) }, plan, vectors);
    expect(bird).toEqual([{ termId: "bird", score: expect.any(Number), source: "clip" }]);
    expect(bird[0].score).toBeGreaterThan(0.5);
    // The none option wins: nothing, though bird beats mammal.
    expect(suggestSmartTags({ ...p, vector: unit([0.3, 0, 1]) }, plan, vectors)).toEqual([]);
    // Mammal wins but isn't validated: nothing.
    expect(suggestSmartTags({ ...p, vector: unit([0, 1, 0]) }, plan, vectors)).toEqual([]);
  });
  it("many: capped, strongest first", () => {
    const { vectors, plan } = toy(cal({ a: 0.1, b: 0.1, c: 0.1 }));
    const s = suggestSmartTags({ ...base, vector: unit([0.9, 0.5, 0.3]) }, plan, vectors);
    expect(s.map((x) => x.termId)).toEqual(["a", "b"]);
  });
  it("gates: species, people, scene and crop", () => {
    const { vectors, plan } = toy(cal({ bird: 0.5, hike: 0.1, wet: 0.1, fly: 0.1 }));
    const v = unit([1, 0, 0]);
    expect(suggestSmartTags({ ...base, vector: v }, plan, vectors)).toEqual([]);
    expect(
      suggestSmartTags({ ...base, vector: v, sceneLabels: { person: 10, water: 30 } }, plan, vectors).map(
        (s) => s.termId,
      ),
    ).toEqual(["hike", "wet"]);
    // Scene terms need their scene labels as well as the CLIP score; the score is the coverage.
    expect(suggestSmartTags({ ...base, vector: v, sceneLabels: { water: 3 } }, plan, vectors)).toEqual([]);
    expect(suggestSmartTags({ ...base, vector: v, sceneLabels: { water: 30 } }, plan, vectors)).toEqual([
      { termId: "wet", score: 0.3, source: "scene" },
    ]);
  });
  it("stays off for another vocabulary or model, without the text model, and without a vector", () => {
    expect(toy(cal({ a: 0.1 }, { vocabVersion: "8" })).plan.active.size).toBe(0);
    expect(toy(cal({ a: 0.1 }, { textModel: "other" })).plan.active.size).toBe(0);
    expect(planSmartTags({ ...MODELS, clip: false, vocab: toyVocab, calibration: cal({ a: 0.1 }) }).active.size).toBe(
      0,
    );
    const { vectors, plan } = toy(cal({ a: 0.1 }));
    expect(suggestSmartTags({ ...base }, plan, vectors)).toEqual([]);
  });
  it("puts vocabulary, calibration and models in the version", () => {
    const a = toy(cal({ a: 0.1 })).plan.version;
    expect(toy(cal({ a: 0.1 }, { createdAt: "t2" })).plan.version).not.toBe(a);
    expect(planSmartTags({ ...MODELS, clip: false, vocab: toyVocab, calibration: cal({ a: 0.1 }) }).version).not.toBe(
      a,
    );
  });
});

describe("shipped vocabulary and default calibration", () => {
  it("switches on only computed terms and the validated Subject terms", () => {
    const plan = planSmartTags({
      imageModel: DEFAULT_SMART_TAG_CALIBRATION.imageModel,
      textModel: DEFAULT_SMART_TAG_CALIBRATION.textModel,
      clip: true,
    });
    expect([...plan.active.keys()].sort()).toEqual([
      "subject.amphibian",
      "subject.bird",
      "subject.mammal",
      "subject.marine-invertebrate",
      "subject.reptile",
    ]);
    expect(plan.computed.size).toBe(SMART_TAG_VOCAB.terms.filter((t) => t.signal === "computed").length);
  });
});
