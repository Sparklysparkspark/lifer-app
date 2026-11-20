import { describe, expect, it } from "vitest";
import {
  makePictureScorer,
  NOISE_PROMPTS,
  parseSearchQuery,
  rankSearch,
  sunFits,
  sunPosition,
  type GroupPredicate,
  type LightStats,
  type SearchRow,
} from "@lifer/shared";
import { migratedDb } from "../store/testDb";
import { applyCaptureChanges } from "../store/library";
import { saveRegion } from "../store/regions";
import { capture, NOW } from "../testing/seed";
import { applyFramePage } from "./frameStore";
import { cachedEmbedder, phoneScorer, searchLocal } from "./localSearch";
import { applyVectorPage, VectorIndex } from "./vectorStore";
import { encodeVector, unit } from "./vectorTestUtil";

// A stand-in for CLIP: each idea is a direction, the noise prompts another, anything else a weak one.
const AXES: [RegExp, number][] = [
  [/stalking/, 1],
  [/tree/, 2],
  [/eye contact/, 3],
  [/backlit/, 4],
  [new RegExp(NOISE_PROMPTS.join("|")), 5],
  [/blue hour|dusk|twilight/, 6],
];
const embed = async (texts: string[]) =>
  texts.map((t) => {
    const w = new Array(8).fill(0.02);
    for (const [re, axis] of AXES) if (re.test(t)) w[axis] += 1;
    return unit(w);
  });

// London at the day's blue hour: found with the shared sun maths, not hand-picked.
const LONDON = { lat: 51.5, lon: -0.12 };
function blueHour(): string {
  for (let m = 0; m < 600; m++) {
    const at = new Date(Date.UTC(2026, 9, 20, 15, 0) + m * 60_000);
    if (sunFits("blueHour", sunPosition(at, LONDON.lat, LONDON.lon))) return at.toISOString();
  }
  throw new Error("no blue hour");
}
const DUSK = blueHour();
const NOON = "2026-10-20T12:00:00.000Z";
const DAY_LIGHT: LightStats = { luma: 0.6, warmth: 0.05, highlights: 0.1, shadows: 0.05, saturation: 0.4 };
const COOL_LIGHT: LightStats = { luma: 0.3, warmth: -0.05, highlights: 0.02, shadows: 0.2, saturation: 0.3 };

interface Photo {
  id: string;
  sci: string;
  common: string;
  cls: string;
  order: string;
  family: string;
  at: string;
  place?: { lat: number; lon: number };
  camera?: string;
  frame?: { box: number[] | null; unsure: boolean; aspect: number; light: LightStats; zoned: boolean | null };
  vec: number[];
  behind?: number[];
}
// Boxes: a golden ratio point, a thirds point, the centre.
const PHI = [0.3, 0.3, 0.46, 0.46];
const THIRDS = [0.26, 0.26, 0.4, 0.4];
const MIDDLE = [0.4, 0.4, 0.6, 0.6];
const PHOTOS: Photo[] = [
  {
    id: "1",
    sci: "Falco peregrinus",
    common: "Peregrine Falcon",
    cls: "aves",
    order: "falconiformes",
    family: "falconidae",
    at: DUSK,
    place: LONDON,
    camera: "Canon EOS R5",
    frame: { box: PHI, unsure: false, aspect: 1.5, light: COOL_LIGHT, zoned: true },
    vec: [0, 1, 0, 1, 1],
    behind: [0, 0, 1],
  },
  {
    id: "2",
    sci: "Vulpes vulpes",
    common: "Red Fox",
    cls: "mammalia",
    order: "carnivora",
    family: "canidae",
    at: DUSK,
    place: LONDON,
    camera: "iPhone 15",
    frame: { box: THIRDS, unsure: false, aspect: 0.75, light: COOL_LIGHT, zoned: true },
    vec: [0, 1, 0, 0, 1],
    behind: [0, 0, 1],
  },
  {
    id: "3",
    sci: "Tyto alba",
    common: "Barn Owl",
    cls: "aves",
    order: "strigiformes",
    family: "tytonidae",
    at: NOON,
    place: LONDON,
    camera: "Canon EOS R5",
    frame: { box: PHI, unsure: false, aspect: 1.5, light: DAY_LIGHT, zoned: true },
    vec: [0, 0, 0, 1, 1],
    behind: [0, 0, 0.3, 1],
  },
  {
    id: "4",
    sci: "Anas crecca",
    common: "Eurasian Teal",
    cls: "aves",
    order: "anseriformes",
    family: "anatidae",
    at: DUSK,
    place: LONDON,
    frame: { box: MIDDLE, unsure: false, aspect: 1.5, light: COOL_LIGHT, zoned: true },
    vec: [0, 0, 1, 0, 1],
  },
  // No place: the sun can't be placed, so the picture decides; no background vector either.
  {
    id: "5",
    sci: "Aquila chrysaetos",
    common: "Golden Eagle",
    cls: "aves",
    order: "accipitriformes",
    family: "accipitridae",
    at: DUSK,
    frame: { box: PHI, unsure: false, aspect: 1.5, light: COOL_LIGHT, zoned: true },
    vec: [0, 1, 1, 1, 1, 0, 1],
  },
  // The file gave no time zone, so the time can't be trusted for the sun.
  {
    id: "6",
    sci: "Canis lupus",
    common: "Grey Wolf",
    cls: "mammalia",
    order: "carnivora",
    family: "canidae",
    at: DUSK,
    place: LONDON,
    frame: { box: PHI, unsure: false, aspect: 1.5, light: COOL_LIGHT, zoned: false },
    vec: [0, 1, 0, 0, 1, 0, 1],
    behind: [0, 0, 1],
  },
  // Never read by the detector.
  {
    id: "7",
    sci: "Lynx lynx",
    common: "Eurasian Lynx",
    cls: "mammalia",
    order: "carnivora",
    family: "felidae",
    at: NOON,
    vec: [0, 1, 0, 0, 1],
  },
  // The detector was unsure of the box.
  {
    id: "8",
    sci: "Falco peregrinus",
    common: "Peregrine Falcon",
    cls: "aves",
    order: "falconiformes",
    family: "falconidae",
    at: DUSK,
    place: LONDON,
    camera: "Canon EOS R5",
    frame: { box: PHI, unsure: true, aspect: 1.5, light: COOL_LIGHT, zoned: true },
    vec: [0, 1, 0, 1, 1],
    behind: [0, 0, 1],
  },
];

// The hub's region tree and species aliases, as /sync/search-vocab gives them. Photo 1 sits in a province.
const TREE = [
  { id: "world", name: "World", parent: null },
  { id: "ctry", name: "Wonderland", parent: "world" },
  { id: "prov", name: "Northshire", parent: "ctry" },
];
const ALIASES: Record<string, string[]> = { "Falco peregrinus": ["duck hawk"] };
const regionOf = (id: string) => (id === "1" ? "prov" : null);

async function library() {
  const db = await migratedDb();
  for (const r of TREE)
    await db.run("INSERT INTO search_regions (id, name, parent_id) VALUES (?, ?, ?)", [r.id, r.name, r.parent]);
  for (const [sci, aliases] of Object.entries(ALIASES))
    await db.run("INSERT INTO species_names (scientific_name, aliases, codes) VALUES (?, ?, '[]')", [
      sci,
      JSON.stringify(aliases),
    ]);
  const seen = new Map(PHOTOS.map((p) => [p.sci, p]));
  await saveRegion(
    db,
    { key: "hub:r1", name: "Norfolk", source: "hub", hubRegionId: "r1" },
    [...seen.values()].map((p) => ({
      scientificName: p.sci,
      commonName: p.common,
      taxonClass: p.cls,
      tier: null,
      vagrant: false,
      sensitive: false,
      taxonOrder: p.order,
      family: p.family,
    })),
    NOW,
  );
  await applyCaptureChanges(
    db,
    PHOTOS.map((p) =>
      capture(p.id, p.sci, p.at, {
        lat: p.place?.lat ?? null,
        lon: p.place?.lon ?? null,
        cameraModel: p.camera ?? null,
        regionId: regionOf(p.id),
      }),
    ),
    [],
  );
  await applyVectorPage(db, {
    imageModelVersion: "m1",
    dimension: 768,
    removed: [],
    last: null,
    next: null,
    items: PHOTOS.map((p) => ({ id: p.id, updatedAt: "x", vector: encodeVector(unit(p.vec)) })),
  });
  await applyFramePage(db, {
    imageModelVersion: "m1",
    removed: [],
    last: null,
    next: null,
    items: PHOTOS.filter((p) => p.frame).map((p) => ({
      id: p.id,
      updatedAt: "x",
      box: p.frame!.box,
      boxUnsure: p.frame!.unsure,
      aspect: p.frame!.aspect,
      light: p.frame!.light,
      takenAtZoned: p.frame!.zoned,
      background: p.behind ? encodeVector(unit(p.behind)) : null,
    })),
  });
  return db;
}

// The same photos as the shared code is given directly, with no phone code between.
const reference = (): SearchRow[] =>
  PHOTOS.map((p) => ({
    capture_id: p.id,
    photo_id: `p-${p.id}`,
    species_id: p.sci,
    quality_rating: null,
    taken_at: p.at,
    tags: [],
    region_id: regionOf(p.id),
    location_label: null,
    trip_id: null,
    album_ids: null,
    focal_length_mm: null,
    embedding_computed_at: null,
    common_name: p.common,
    scientific_name: p.sci,
    taxon_class: p.cls,
    taxon_order: p.order,
    family: p.family,
    tier: null,
    camera_model: p.camera ?? null,
    lat: p.place?.lat ?? null,
    lon: p.place?.lon ?? null,
    width: 100,
    height: 80,
    frame_box: p.frame?.box ?? null,
    frame_unsure: p.frame ? p.frame.unsure : null,
    frame_aspect: p.frame?.aspect ?? null,
    light_stats: p.frame?.light ?? null,
    taken_at_zoned: p.frame ? p.frame.zoned : null,
  }));

const EXAMPLE =
  "Predators stalking at blue hour with a tree in the background, making eye contact with the camera, uses the golden ratio, and is backlit";
const QUERIES = [
  EXAMPLE,
  "predators",
  "blue hour",
  "predators at blue hour",
  "golden ratio",
  "vertical",
  "tree in the background",
  "r5",
  "falcons backlit",
  "wonderland",
  "northshire",
  "duck hawk",
  "raptors",
  "songbirds",
  "waterbirds",
];

async function both(q: string) {
  const db = await library();
  const [index, behind] = await Promise.all([VectorIndex.load(db), VectorIndex.load(db, "capture_backgrounds")]);
  const cached = cachedEmbedder(embed);
  const ours = await searchLocal(
    db,
    q,
    phoneScorer(cached, () => index),
    phoneScorer(cached, () => behind),
    NOW,
  );

  const rows = reference();
  const species = [...new Map(PHOTOS.map((p) => [p.sci, p])).values()].map((p) => ({
    id: p.sci,
    commonName: p.common,
    scientificName: p.sci,
    taxonClass: p.cls,
    taxonOrder: p.order,
    family: p.family,
    aliases: ALIASES[p.sci] ?? [],
    codes: [],
  }));
  const latinGroups = new Map<string, GroupPredicate>(
    PHOTOS.flatMap((p): [string, GroupPredicate][] => [
      [p.order, { orders: [p.order] }],
      [p.family, { families: [p.family] }],
    ]),
  );
  const catalogHeads = new Set(PHOTOS.map((p) => p.common.toLowerCase().replace(/^.* /, "")));
  const cameras = [...new Set(PHOTOS.flatMap((p) => (p.camera ? [p.camera] : [])))];
  const parsed = parseSearchQuery(
    q,
    {
      species,
      places: TREE.filter((r) => r.parent).map((r) => ({ kind: "region" as const, id: r.id, name: r.name })),
      latinGroups,
      catalogHeads,
      cameras,
      now: NOW,
    },
    { partialWordPicksSpecies: false },
  );
  const exact = new Map(PHOTOS.map((p) => [p.id, unit(p.vec)] as const));
  const exactBehind = new Map(PHOTOS.filter((p) => p.behind).map((p) => [p.id, unit(p.behind!)] as const));
  const ref = await rankSearch(
    q,
    parsed,
    rows,
    async (ids) =>
      new Set(
        TREE.filter((r) =>
          ids.some(
            (id) => r.id === id || r.parent === id || (r.parent && TREE.find((x) => x.id === r.parent)?.parent === id),
          ),
        ).map((r) => r.id),
      ),
    makePictureScorer(embed, async () => exact),
    { backgroundScore: makePictureScorer(embed, async () => exactBehind) },
  );
  return { ours, ref };
}

describe("phone search ranks like the shared code on the same data", () => {
  it.each(QUERIES)("%s", async (q) => {
    const { ours, ref } = await both(q);
    expect(ours.photos.map((p) => p.photoId)).toEqual(
      ref.items.map((i) => (i.row as unknown as { photo_id: string }).photo_id),
    );
    expect(ours.parts).toEqual(ref.interpretation.parts ?? []);
  });
});

describe("region tree and aliases on the phone", () => {
  it("finds a photo by its country, its province and an alias", async () => {
    for (const q of ["wonderland", "northshire"])
      expect(
        (await both(q)).ours.photos.map((p) => p.photoId),
        q,
      ).toEqual(["p-1"]);
    expect((await both("duck hawk")).ours.photos.map((p) => p.photoId)).toContain("p-1");
  });
});

describe("what the frames and capture data add on the phone", () => {
  it("reads the example query into its parts, light and composition among them", async () => {
    const { ours } = await both(EXAMPLE);
    const kinds = ours.parts.map((p) => p.kind);
    expect(kinds).toEqual(expect.arrayContaining(["group", "light", "background", "composition"]));
    expect(ours.parts.find((p) => p.kind === "group")?.label).toBe("predators");
    // A light part is best-effort here: photo 5 has no place, so it was judged by the picture.
    expect(ours.parts.find((p) => p.kind === "light")?.exact).toBe(false);
  });

  it("places the sun from the photo's coordinates and time", async () => {
    const { ours } = await both("predators at blue hour");
    const ids = ours.photos.map((p) => p.photoId);
    expect(ids).toEqual(expect.arrayContaining(["p-1", "p-2", "p-8"]));
    expect(ids).not.toContain("p-3");
  });

  it("keeps a golden ratio photo only when the detector was sure of its box", async () => {
    const { ours } = await both("golden ratio");
    expect(ours.photos.map((p) => p.photoId).sort()).toEqual(["p-1", "p-3", "p-5", "p-6"]);
  });

  it("reads orientation from the stored shape and the camera from the capture feed", async () => {
    expect((await both("vertical")).ours.photos.map((p) => p.photoId)).toEqual(["p-2"]);
    expect((await both("r5")).ours.photos.map((p) => p.photoId).sort()).toEqual(["p-1", "p-3", "p-8"]);
  });

  it("ranks by the background vector, and falls back to the whole photo where there is none", async () => {
    const { ours } = await both("tree in the background");
    const ids = ours.photos.map((p) => p.photoId);
    expect(ids.slice(0, 4).sort()).toEqual(["p-1", "p-2", "p-6", "p-8"]);
    // Photo 4 has no background vector: its whole photo, a tree, stands in.
    expect(ids).toContain("p-4");
  });
});

describe("cachedEmbedder", () => {
  it("embeds each description once across scorers", async () => {
    let asked = 0;
    const cached = cachedEmbedder(async (texts) => ((asked += texts.length), embed(texts)));
    await cached(["a", "b"]);
    await cached(["b", "c", "a"]);
    expect(asked).toBe(3);
  });
});
