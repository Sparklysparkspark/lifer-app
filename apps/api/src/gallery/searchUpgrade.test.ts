import { describe, expect, it } from "vitest";
import {
  compositionFits,
  compositionOf,
  lightAllows,
  parseSearchQuery,
  rankSearch,
  sunDecides,
  sunFits,
  sunPosition,
  speciesInGroup,
  timeMaybeWrong,
  trustedSun,
  type FrameBox,
  type LightStats,
  type PictureScorer,
  type SearchRow,
  type SpeciesEntry,
} from "@lifer/shared";

/** Minutes in a day (from `from`, UTC) the sun fits a time of day at a place. */
function minutesOf(t: Parameters<typeof sunFits>[0], from: string, lat: number, lon: number): number {
  let n = 0;
  for (let m = 0; m < 24 * 60; m++)
    if (sunFits(t, sunPosition(new Date(new Date(from).getTime() + m * 60_000), lat, lon))) n += 1;
  return n;
}

describe("blue hour and twilight from the sun", () => {
  it("lasts minutes at the equator and longer at mid latitudes, twice a day", () => {
    // About 8 minutes each at the equator (the sun drops straight down), 13 or so in London.
    const quito = minutesOf("blueHour", "2024-03-20T00:00:00Z", -0.18, -78.47);
    const london = minutesOf("blueHour", "2024-03-20T00:00:00Z", 51.48, 0);
    expect(quito).toBeGreaterThanOrEqual(12);
    expect(quito).toBeLessThanOrEqual(22);
    expect(london).toBeGreaterThan(quito);
    expect(london).toBeLessThanOrEqual(40);
    // Civil twilight holds the blue hour.
    expect(minutesOf("twilight", "2024-03-20T00:00:00Z", 51.48, 0)).toBeGreaterThan(london);
  });

  it("works in the southern hemisphere's winter", () => {
    expect(minutesOf("blueHour", "2024-06-21T00:00:00Z", -33.92, 18.42)).toBeGreaterThan(10);
  });

  it("goes by the sun, not the clock: blue hour at solar midnight in a Norwegian June", () => {
    // 61.5 N in late June: the sun bottoms out about 5 degrees down around 01:20 local time.
    const sun = sunPosition(new Date("2024-06-20T23:20:00Z"), 61.5, 10);
    expect(sunFits("blueHour", sun)).toBe(true);
    expect(sunFits("night", sun)).toBe(false);
  });

  it("has no blue hour or night under the midnight sun", () => {
    expect(minutesOf("blueHour", "2024-06-21T00:00:00Z", 69.65, 18.96)).toBe(0);
    expect(minutesOf("night", "2024-06-21T00:00:00Z", 69.65, 18.96)).toBe(0);
    // 01:00 in Tromso is golden light, not night.
    expect(sunFits("goldenHour", sunPosition(new Date("2024-06-20T23:00:00Z"), 69.65, 18.96))).toBe(true);
  });
});

const daylit: LightStats = { luma: 0.5, warmth: 0.02, highlights: 0.05, shadows: 0.03, saturation: 0.35 };
const dark: LightStats = { luma: 0.12, warmth: 0.01, highlights: 0.04, shadows: 0.6, saturation: 0.3 };
const dusky: LightStats = { luma: 0.2, warmth: -0.06, highlights: 0, shadows: 0.2, saturation: 0.25 };
// Midnight in London (UTC) and midday there.
const NIGHT = "2024-03-20T00:00:00Z";
const NOON = "2024-03-20T12:00:00Z";

describe("light trust", () => {
  it("trusts the sun only with GPS, a time and a known time zone", () => {
    expect(trustedSun({ taken_at: NOON, lat: 51.48, lon: 0, taken_at_zoned: true })).not.toBeNull();
    // Imported before zones were recorded: trusted, as before.
    expect(trustedSun({ taken_at: NOON, lat: 51.48, lon: 0 })).not.toBeNull();
    expect(trustedSun({ taken_at: NOON, lat: null, lon: null })).toBeNull();
    expect(trustedSun({ taken_at: NOON, lat: 51.48, lon: 0, taken_at_zoned: false })).toBeNull();
  });

  it("leaves a photo without GPS to the picture", () => {
    expect(sunDecides("night", { taken_at: NIGHT, lat: null, lon: null })).toBeNull();
  });

  it("flags a wrong camera clock: the sun was well down but the photo is daylit", () => {
    const row = { taken_at: NIGHT, lat: 51.48, lon: 0, taken_at_zoned: true, light_stats: daylit };
    expect(timeMaybeWrong(trustedSun(row), daylit)).toBe(true);
    // The picture decides instead of the sun.
    expect(sunDecides("night", row)).toBeNull();
    // An infrared trail camera frame is bright but grey: not flagged.
    expect(timeMaybeWrong(trustedSun(row), { ...daylit, saturation: 0.02 })).toBe(false);
  });

  it("never flags an indoor or flash shot taken in daylight", () => {
    const row = { taken_at: NOON, lat: 51.48, lon: 0, taken_at_zoned: true, light_stats: dark };
    expect(timeMaybeWrong(trustedSun(row), dark)).toBe(false);
    expect(sunDecides("night", row)).toBe(false);
    expect(sunDecides("midday", row)).toBe(true);
  });

  it("lets a photo's own light veto the picture model", () => {
    expect(lightAllows("blueHour", dusky)).toBe(true);
    expect(lightAllows("blueHour", daylit)).toBe(false);
    expect(lightAllows("night", daylit)).toBe(false);
    expect(lightAllows("goldenHour", { ...daylit, warmth: 0.12 })).toBe(true);
    expect(lightAllows("goldenHour", dusky)).toBe(false);
    expect(lightAllows("night", null)).toBe(true);
  });
});

describe("composition from the subject box", () => {
  const boxAt = (cx: number, cy: number, side = 0.1): FrameBox => [
    cx - side / 2,
    cy - side / 2,
    cx + side / 2,
    cy + side / 2,
  ];

  it("places the box centre on the thirds and phi grids", () => {
    expect(compositionOf(boxAt(1 / 3, 1 / 3))).toMatchObject({ thirds: true, goldenRatio: false, centred: false });
    expect(compositionOf(boxAt(0.618, 0.382))).toMatchObject({ goldenRatio: true, thirds: true });
    expect(compositionOf(boxAt(0.618, 0.618)).goldenRatio).toBe(true);
    expect(compositionOf(boxAt(0.25, 0.5)).thirds).toBe(false);
    expect(compositionOf(boxAt(0.5, 0.5))).toMatchObject({ centred: true, thirds: false, goldenRatio: false });
  });

  it("sizes the subject by its share of the frame", () => {
    expect(compositionOf(boxAt(0.3, 0.3, 0.1)).size).toBe("tiny");
    expect(compositionOf(boxAt(0.3, 0.3, 0.2)).size).toBe("small");
    expect(compositionOf(boxAt(0.5, 0.5, 0.5)).size).toBe("medium");
    // A frame-filling animal has no grid point to sit on.
    expect(compositionOf([0.05, 0.05, 0.75, 0.75])).toMatchObject({ size: "frameFilling", thirds: false });
  });

  it("can't tell placement without a sure box, but always knows orientation", () => {
    expect(compositionFits("ruleOfThirds", { box: null, unsure: false, aspect: 1.5 })).toBeNull();
    expect(compositionFits("ruleOfThirds", { box: boxAt(1 / 3, 1 / 3), unsure: true, aspect: 1.5 })).toBeNull();
    expect(compositionFits("vertical", { box: null, unsure: true, aspect: 0.66 })).toBe(true);
    expect(compositionFits("horizontal", { box: null, unsure: true, aspect: 0.66 })).toBe(false);
    expect(compositionFits("smallInFrame", { box: boxAt(0.5, 0.5, 0.2), unsure: false, aspect: 1 })).toBe(true);
  });
});

let n = 0;
const sp = (commonName: string, taxonClass: string, taxonOrder: string, family: string): SpeciesEntry => ({
  id: `s${++n}`,
  commonName,
  scientificName: commonName,
  taxonClass,
  taxonOrder,
  family,
  aliases: [],
  codes: [],
});
const species = [
  sp("Gray Wolf", "mammalia", "Carnivora", "Canidae"),
  sp("Bald Eagle", "aves", "Accipitriformes", "Accipitridae"),
  sp("Turkey Vulture", "aves", "Cathartiformes", "Cathartidae"),
  sp("Moose", "mammalia", "Artiodactyla", "Cervidae"),
  sp("Wild Boar", "mammalia", "Artiodactyla", "Suidae"),
  sp("Humpback Whale", "aquatic_mammalia", "Artiodactyla", "Balaenopteridae"),
  sp("Mallard", "aves", "Anseriformes", "Anatidae"),
  sp("Great Egret", "aves", "Pelecaniformes", "Ardeidae"),
  sp("Giant Panda", "mammalia", "Carnivora", "Ursidae"),
];
const parse = (q: string) => parseSearchQuery(q, { species, places: [], latinGroups: new Map() });
const EXAMPLE =
  "predators stalking at blue hour with a tree in the background, making eye contact with the camera, uses the golden ratio, and is backlit";

describe("parser splitting", () => {
  it("splits the long example into its parts, each read by the right signal", () => {
    const p = parse(EXAMPLE);
    expect(p.labels.groups).toEqual(["predators"]);
    expect([...p.readings].sort()).toEqual(["blueHour", "goldenRatio"]);
    expect(p.backgrounds).toEqual(["tree"]);
    expect(p.scenes).toEqual([]);
    expect(p.labels.styles).toEqual(["making eye contact with the camera", "backlit"]);
    expect(p.parts!.map((x) => [x.kind, x.label, x.exact])).toEqual([
      ["group", "predators", true],
      ["description", "stalking", false],
      ["light", "blue hour", true],
      ["background", "tree", false],
      ["style", "making eye contact with the camera", false],
      ["composition", "golden ratio", true],
      ["style", "backlit", false],
    ]);
    // The background and composition words stay out of what the picture model reads.
    expect(p.description).toContain("stalking");
    expect(p.description).not.toContain("tree");
    expect(p.description).not.toContain("golden");
    // Each part carries its words, to take out of the query.
    expect(p.parts!.find((x) => x.kind === "background")!.text).toBe("tree in the background");
  });

  it("reads other ways of putting something behind the animal", () => {
    expect(parse("eagle against the sky").backgrounds).toEqual(["sky"]);
    expect(parse("moose with water behind it").backgrounds).toEqual(["water"]);
    expect(parse("wolf with snowy mountains in the background").backgrounds).toEqual(["snowy mountains"]);
    expect(parse("wolf against a snowy background").backgrounds).toEqual(["snowy"]);
    // Something the animal hides behind is in front of it.
    expect(parse("egret hiding behind reeds").backgrounds).toBeUndefined();
  });

  it("reads composition and light words in other phrasings", () => {
    expect([...parse("rule of thirds owl").readings]).toEqual(["ruleOfThirds"]);
    expect([...parse("moose small in the frame").readings]).toEqual(["smallInFrame"]);
    expect([...parse("frame filling eagle").readings]).toEqual(["frameFilling"]);
    expect([...parse("vertical twilight egret").readings].sort()).toEqual(["twilight", "vertical"]);
    // "golden" alone is still a colour, and "golden hour" still the time of day.
    expect(parse("golden").scenes).toHaveLength(1);
    expect([...parse("golden hour").readings]).toEqual(["goldenHour"]);
  });

  it("knows the new group words, conservatively", () => {
    const groupOf = (q: string) => {
      const g = parse(q).groups[0].predicate;
      return species.filter((s) => speciesInGroup(s, g)).map((s) => s.commonName);
    };
    expect(groupOf("predators")).toEqual(["Gray Wolf", "Bald Eagle"]);
    expect(groupOf("herbivores")).toEqual(["Moose"]);
    expect(groupOf("waterbirds")).toEqual(["Mallard", "Great Egret"]);
    expect(groupOf("wading birds")).toEqual(["Great Egret"]);
  });

  it("keeps single words as before", () => {
    const p = parse("stalking");
    expect(p.description).toBe("stalking");
    expect(p.parts).toEqual([{ kind: "description", label: "stalking", text: "stalking", exact: false }]);
  });
});

// Each photo's picture model matches: a prompt scores 0.2 when it names one of the photo's words.
function scorerFor(words: Record<string, string[]>): PictureScorer {
  return async (text, rows) => rows.map((r) => ((words[r.capture_id] ?? []).some((w) => text.includes(w)) ? 0.2 : 0));
}

function row(id: string, speciesName: string, extra: Partial<SearchRow> = {}): SearchRow {
  const s = species.find((x) => x.commonName === speciesName)!;
  return {
    capture_id: id,
    species_id: s.id,
    quality_rating: null,
    taken_at: null,
    tags: null,
    region_id: null,
    location_label: null,
    focal_length_mm: null,
    embedding_computed_at: "x",
    common_name: s.commonName,
    scientific_name: s.scientificName,
    taxon_class: s.taxonClass,
    taxon_order: s.taxonOrder,
    family: s.family,
    ...extra,
  };
}

describe("ranking", () => {
  const goldenBox: FrameBox = [0.57, 0.33, 0.67, 0.43];
  const centreBox: FrameBox = [0.45, 0.45, 0.55, 0.55];
  // Blue hour in London on the equinox evening (about 18:30 UTC); the zone known.
  const blue = { taken_at: "2024-03-20T18:35:00Z", lat: 51.48, lon: 0, taken_at_zoned: true };
  const noon = { taken_at: NOON, lat: 51.48, lon: 0, taken_at_zoned: true };

  it("requires exact parts and ranks by the fuzzy ones", async () => {
    expect(sunFits("blueHour", trustedSun(blue)!)).toBe(true);
    const rows = [
      row("a", "Gray Wolf", { ...blue, frame_box: goldenBox, frame_aspect: 1.5, light_stats: dusky }),
      row("b", "Bald Eagle", { ...blue, frame_box: goldenBox, frame_aspect: 1.5, light_stats: dusky }),
      // Wrong light, wrong composition, not a predator: each filtered out.
      row("c", "Gray Wolf", { ...noon, frame_box: goldenBox, frame_aspect: 1.5, light_stats: daylit }),
      row("d", "Gray Wolf", { ...blue, frame_box: centreBox, frame_aspect: 1.5, light_stats: dusky }),
      row("e", "Moose", { ...blue, frame_box: goldenBox, frame_aspect: 1.5, light_stats: dusky }),
      // Not read yet: placement can't be told, so it's left out.
      row("f", "Gray Wolf", { ...blue }),
    ];
    const whole = scorerFor({ a: ["stalking", "camera"], b: ["backlit"] });
    // Background vectors: only "b" has a tree behind it.
    const behind = scorerFor({ b: ["tree"] });
    const out = await rankSearch(EXAMPLE, parse(EXAMPLE), rows, async () => new Set(), whole, {
      backgroundScore: behind,
    });
    // "b" also has the tree behind it, so it ranks first.
    expect(out.items.map((i) => i.row.capture_id)).toEqual(["b", "a"]);
    const parts = out.interpretation.parts!;
    expect(parts.find((x) => x.kind === "light")!.exact).toBe(true);
    expect(out.interpretation.backgrounds).toEqual(["tree"]);
  });

  it("ranks by the background vector, and the whole photo for one without", async () => {
    const rows = [row("a", "Gray Wolf"), row("b", "Gray Wolf"), row("c", "Gray Wolf")];
    const whole = scorerFor({ c: ["water"] });
    const behind: PictureScorer = async (_t, rs) =>
      rs.map((r) => (r.capture_id === "b" ? 0.3 : r.capture_id === "a" ? 0 : null));
    const out = await rankSearch(
      "wolf with water behind",
      parse("wolf with water behind"),
      rows,
      async () => new Set(),
      whole,
      {
        backgroundScore: behind,
      },
    );
    // Every wolf is kept (a fuzzy part never filters a subject's photos), best background first.
    expect(out.items.map((i) => i.row.capture_id)).toEqual(["b", "c", "a"]);
  });

  it("labels the light 'probably' when some photos were judged by the picture", async () => {
    const rows = [
      row("a", "Gray Wolf", { ...blue }),
      // No GPS: the picture says blue hour, and its own light agrees.
      row("b", "Gray Wolf", { taken_at: NOON, light_stats: dusky }),
      // No GPS: the picture says blue hour, but the photo is plainly bright.
      row("c", "Gray Wolf", { taken_at: NOON, light_stats: daylit }),
      // Wrong camera clock: the sun says night, the photo is daylit and looks like midday.
      row("d", "Gray Wolf", { taken_at: NIGHT, lat: 51.48, lon: 0, taken_at_zoned: true, light_stats: daylit }),
    ];
    const whole = scorerFor({ b: ["blue hour"], c: ["blue hour"], d: ["midday"] });
    const blueOut = await rankSearch("wolf blue hour", parse("wolf blue hour"), rows, async () => new Set(), whole);
    expect(blueOut.items.map((i) => i.row.capture_id).sort()).toEqual(["a", "b"]);
    expect(blueOut.interpretation.parts!.find((x) => x.kind === "light")!.exact).toBe(false);

    const nightOut = await rankSearch("wolf night", parse("wolf night"), rows, async () => new Set(), whole);
    expect(nightOut.items.map((i) => i.row.capture_id)).toEqual([]);
    const middayOut = await rankSearch("wolf midday", parse("wolf midday"), rows, async () => new Set(), whole);
    expect(middayOut.items.map((i) => i.row.capture_id)).toEqual(["d"]);
  });

  it("filters on orientation from the photo's own size before the frame is read", async () => {
    const rows = [row("a", "Moose", { width: 4000, height: 6000 }), row("b", "Moose", { width: 6000, height: 4000 })];
    const out = await rankSearch("vertical moose", parse("vertical moose"), rows, async () => new Set(), scorerFor({}));
    expect(out.items.map((i) => i.row.capture_id)).toEqual(["a"]);
  });
});
