import { describe, expect, it, vi } from "vitest";
import { parseSearchQuery, rankSearch, type SpeciesEntry, type PlaceEntry, type SearchRow } from "./photoSearch.js";

// A two-dimensional stand-in for CLIP: "purple" prompts point one way, everything else the other.
const clip = vi.hoisted(() => ({ photos: new Map<string, Float32Array>() }));
vi.mock("@lifer/core/species/textEmbedding.js", () => ({
  embedTextVectors: async (texts: string[]) =>
    texts.map((t) => new Float32Array(t.includes("purple") ? [1, 0] : [0, 1])),
}));
vi.mock("@lifer/core/species/embeddings.js", () => ({
  captureVectors: async (_pool: unknown, _table: string, _version: string, rows: Array<{ capture_id: string }>) =>
    new Map(
      rows.filter((r) => clip.photos.has(r.capture_id)).map((r) => [r.capture_id, clip.photos.get(r.capture_id)!]),
    ),
  clearYourVectorCache: () => {},
}));

let n = 0;
function sp(
  commonName: string,
  scientificName: string,
  taxonClass: string,
  taxonOrder: string,
  family: string,
  aliases: string[] = [],
  codes: string[] = [],
): SpeciesEntry {
  return { id: `s${++n}`, commonName, scientificName, taxonClass, taxonOrder, family, aliases, codes };
}
const species = [
  sp("Snow Goose", "Anser caerulescens", "aves", "Anseriformes", "Anatidae"),
  sp("Canada Goose", "Branta canadensis", "aves", "Anseriformes", "Anatidae"),
  sp("Mallard", "Anas platyrhynchos", "aves", "Anseriformes", "Anatidae"),
  sp("Lesser Scaup", "Aythya affinis", "aves", "Anseriformes", "Anatidae", ["Lesser Scaup Duck"]),
  sp("Wood Duck", "Aix sponsa", "aves", "Anseriformes", "Anatidae"),
  sp("Red-Tailed Hawk", "Buteo jamaicensis", "aves", "Accipitriformes", "Accipitridae", [], ["RTHA"]),
  sp("Peregrine Falcon", "Falco peregrinus", "aves", "Falconiformes", "Falconidae", ["Duck Hawk"]),
  sp("Pileated Woodpecker", "Dryocopus pileatus", "aves", "Piciformes", "Picidae"),
  sp("Northern Flicker", "Colaptes auratus", "aves", "Piciformes", "Picidae", ["Wake-up"]),
  sp("Great Blue Heron", "Ardea herodias", "aves", "Pelecaniformes", "Ardeidae"),
  sp("Northern Flying Squirrel", "Glaucomys sabrinus", "mammalia", "Rodentia", "Sciuridae"),
  sp("Atlantic Cod", "Gadus morhua", "actinopterygii", "Gadiformes", "Gadidae", ["Fish", "Eating Fish"]),
  sp("Moose", "Alces alces", "mammalia", "Artiodactyla", "Cervidae"),
];
const idOf = (name: string) => species.find((s) => s.commonName === name)!.id;
const places: PlaceEntry[] = [
  { kind: "region", id: "r-ca", name: "Canada" },
  { kind: "region", id: "r-on", name: "Ontario" },
  { kind: "location", id: "Prince George", name: "Prince George" },
];
const parse = (q: string) =>
  parseSearchQuery(q, {
    species,
    places,
    latinGroups: new Map([["anatidae", { families: ["anatidae"] }]]),
    now: new Date("2026-09-25"),
  });

describe("parseSearchQuery", () => {
  it("reads a word that's only a describing word in a name as a picture description", () => {
    const p = parse("flying");
    expect(p.speciesIds).toBeNull();
    expect(p.description).toBe("flying");
    expect(p.hintSpeciesIds.has(idOf("Northern Flying Squirrel"))).toBe(true);

    const great = parse("great");
    expect(great.speciesIds).toBeNull();
    expect(great.hintSpeciesIds.has(idOf("Great Blue Heron"))).toBe(true);
  });

  it("takes a full species name as the species", () => {
    expect([...parse("snow goose").speciesIds!]).toEqual([idOf("Snow Goose")]);
    expect([...parse("RTHA").speciesIds!]).toEqual([idOf("Red-Tailed Hawk")]);
  });

  it("uses a species' main noun, and old names only within the same family", () => {
    expect([...parse("hawk").speciesIds!]).toEqual([idOf("Red-Tailed Hawk")]); // not Peregrine ("Duck Hawk")
  });

  it("reads group words as the group", () => {
    const duck = parse("ducks");
    expect(duck.speciesIds).toBeNull();
    expect(duck.labels.groups).toEqual(["ducks"]);
    expect(parse("birds of prey").labels.groups).toEqual(["birds of prey"]);
    expect(parse("Anatidae").labels.groups).toEqual(["Anatidae"]);
  });

  it("doesn't treat a single-word junk alias as the species", () => {
    const p = parse("fish");
    expect(p.speciesIds).toBeNull();
    expect(p.labels.groups).toEqual(["fish"]);
  });

  it("picks one species from several words, allowing a typo", () => {
    expect([...parse("pilated woodpecker").speciesIds!]).toEqual([idOf("Pileated Woodpecker")]);
    expect([...parse("great blue").speciesIds!]).toEqual([idOf("Great Blue Heron")]);
  });

  it("reads places and dates as filters, without eating species names", () => {
    const p = parse("canada goose in ontario");
    expect([...p.speciesIds!]).toEqual([idOf("Canada Goose")]);
    expect(p.places.map((x) => x.name)).toEqual(["Ontario"]);
    expect(p.description).toBeNull();

    const q = parse("birds in Canada last year");
    expect(q.places.map((x) => x.name)).toEqual(["Canada"]);
    expect(q.years).toEqual([2025]);
    expect(parse("owls in winter").months).toEqual([12, 1, 2]);
    expect(parse("prince george 2024").places[0].kind).toBe("location");
  });

  it("treats a second subject after an action as part of the description", () => {
    const p = parse("heron catching fish");
    expect([...p.speciesIds!]).toEqual([idOf("Great Blue Heron")]);
    expect(p.groups).toEqual([]);
    expect(p.description).toBe("heron catching fish");
  });

  it("ignores short words and short word starts", () => {
    expect(parse("close up portrait").speciesIds).toBeNull(); // "Wake-up" is an alias of Northern Flicker
    expect(parse("car").speciesIds).toBeNull();
  });

  it("finds a group or species from a word still being typed", () => {
    expect(parse("woodp").labels.groups).toEqual(["woodpecker"]);
    expect([...parse("moo").speciesIds!]).toEqual([idOf("Moose")]);
    expect([...parse("pil").speciesIds!]).toEqual([idOf("Pileated Woodpecker")]);
    expect([...parse("mallard sw").speciesIds!]).toEqual([idOf("Mallard")]); // "sw" too short to be a start
    // A complete describing word still means the picture.
    expect(parse("snow").speciesIds).toBeNull();
    const water = parse("water");
    expect(water.speciesIds).toBeNull();
    expect(water.groups).toEqual([]); // not the start of "waterfowl"
    expect(water.hintSpeciesIds.size).toBe(0);
    expect(water.labels.scenes).toEqual(["water"]);
    expect(water.description).toBeNull();
  });

  it("describes a partial word by the picture word it's heading for", () => {
    const fly = parse("fly");
    expect(fly.speciesIds).toBeNull();
    expect(fly.description).toBe("flying");
    expect(fly.hintSpeciesIds.has(idOf("Northern Flying Squirrel"))).toBe(true);
    expect(parse("duck swim").description).toBe("duck swimming");
    expect(parse("flying").description).toBe("flying"); // already complete
  });

  it("in the full search too, a partial word picks what it starts and never goes to CLIP raw", () => {
    const full = (q: string) =>
      parseSearchQuery(q, { species, places, latinGroups: new Map() }, { partialWordPicksSpecies: false });
    const moo = full("moo");
    expect([...moo.speciesIds!]).toEqual([idOf("Moose")]);
    expect(moo.description).toBeNull();
    expect(full("woodp").labels.groups).toEqual(["woodpecker"]);
    expect(full("car").groups).toEqual([]); // a group needs four letters here
    expect(full("mo").description).toBeNull(); // too short to mean anything yet
    const heronFl = full("heron fl");
    expect(heronFl.description).toBeNull();
    expect([...heronFl.speciesIds!]).toEqual([idOf("Great Blue Heron")]);
  });

  it("finds nothing for an animal with no photos, even half-typed", () => {
    const catalogHeads = new Set(["tiger", "fisher", "moose", "egg"]);
    const p = (q: string) => parseSearchQuery(q, { species, places, latinGroups: new Map(), catalogHeads });
    for (const q of ["tiger", "tigers", "fisher", "tige"]) {
      expect(p(q).speciesIds).toEqual(new Set());
      expect(p(q).description).toBeNull();
    }
    expect(p("eggs").speciesIds).toBeNull(); // an everyday photo word, even if some animal is named so
    expect([...p("moose").speciesIds!]).toEqual([idOf("Moose")]);
  });

  it("keeps the subject in the picture description", () => {
    const p = parse("mallard swimming in Ontario");
    expect([...p.speciesIds!]).toEqual([idOf("Mallard")]);
    expect(p.description).toBe("mallard swimming");
  });
});

describe("trips and albums in the query", () => {
  const withTrips: PlaceEntry[] = [
    ...places,
    { kind: "region", id: "r-cr", name: "Costa Rica" },
    { kind: "trip", id: "t-cr", name: "Costa Rica 2024" },
    { kind: "trip", id: "t-yard", name: "Backyard" },
    { kind: "album", id: "a-best", name: "Best of Ducks" },
  ];
  const parseT = (q: string) =>
    parseSearchQuery(q, { species, places: withTrips, latinGroups: new Map(), now: new Date("2026-09-25") });

  it("reads '<words> trip' as the trips whose names contain those words", () => {
    const p = parseT("costa rica trip");
    expect(p.places.map((x) => x.id)).toEqual(["t-cr"]);
    expect(p.description).toBeNull();
  });

  it("matches a whole trip or album name", () => {
    expect(parseT("backyard").places.map((x) => x.id)).toEqual(["t-yard"]);
    const album = parseT("best of ducks");
    expect(album.places.map((x) => x.id)).toEqual(["a-best"]);
    expect(album.labels.groups).toEqual([]);
  });

  it("keeps a plain place name a place", () => {
    expect(parseT("costa rica").places.map((x) => x.id)).toEqual(["r-cr"]);
  });

  it("ignores a kind word with nothing meaningful before it", () => {
    expect(parseT("my trip").places).toEqual([]);
  });

  it("finds a species by an old scientific name passed as an alias", () => {
    const old = [sp("Green-Winged Teal", "Anas crecca", "aves", "Anseriformes", "Anatidae", ["Anas carolinensis"])];
    const p = parseSearchQuery("anas carolinensis", { species: old, places: [], latinGroups: new Map() });
    expect([...p.speciesIds!]).toEqual([old[0].id]);
  });
});

describe("scene and colour words", () => {
  it("reads scene words and their synonyms as scene filters", () => {
    const p = parse("ponds");
    expect(p.scenes).toEqual([{ label: "ponds", labels: ["water", "river", "lake", "sea", "waterfall"], min: 5 }]);
    expect(p.labels.scenes).toEqual(["ponds"]);
    expect(p.description).toBeNull();
    expect(parse("forest").scenes).toEqual([{ label: "forest", labels: ["tree"], min: 5 }]);
    expect(parse("flowers").labels.groups).toEqual([]); // the scene, not the plants group
    expect(parse("sea lions").labels.groups).toEqual(["sea lions"]);
  });

  it("reads colour words, with their variants", () => {
    expect(parse("grey").scenes).toEqual([{ label: "grey", color: "gray", min: 5 }]);
    expect(parse("violet").scenes).toEqual([{ label: "violet", color: "purple", min: 5 }]);
  });

  it("needs every scene word, alongside a subject", () => {
    expect(parse("purple leaves").labels.scenes).toEqual(["purple", "leaves"]);
    const p = parse("moose in water");
    expect([...p.speciesIds!]).toEqual([idOf("Moose")]);
    expect(p.labels.scenes).toEqual(["water"]);
    expect(p.description).toBeNull();
    expect(parse("moose swimming in water").description).toBe("moose swimming");
  });

  it("completes a partial scene or colour word rather than sending it to CLIP", () => {
    const purp = parse("purp");
    expect(purp.labels.scenes).toEqual(["purple"]);
    expect(purp.description).toBeNull();
    expect(parse("moose pon").labels.scenes).toEqual(["pond"]);
    expect(parse("sno").labels.scenes).toEqual(["snow"]);
  });

  it("leaves species names and other words alone", () => {
    const goose = parse("snow goose");
    expect([...goose.speciesIds!]).toEqual([idOf("Snow Goose")]);
    expect(goose.scenes).toEqual([]);
    expect(parse("great blue").scenes).toEqual([]);
    const tigers = parse("tigers");
    expect(tigers.scenes).toEqual([]);
    expect(tigers.description).toBe("tigers");
  });
});

describe("rankSearch with scene words", () => {
  const row = (
    id: string,
    scene: { labels?: Record<string, number>; colors?: Record<string, number> } | null,
    rating = 0,
  ): SearchRow => ({
    capture_id: id,
    species_id: idOf("Moose"),
    quality_rating: rating,
    taken_at: null,
    tags: null,
    region_id: null,
    location_label: null,
    focal_length_mm: null,
    embedding_computed_at: "2026-01-01",
    common_name: "Moose",
    scientific_name: "Alces alces",
    taxon_class: "mammalia",
    taxon_order: "Artiodactyla",
    family: "Cervidae",
    scene_labels: scene ? (scene.labels ?? {}) : null,
    scene_colors: scene ? (scene.colors ?? {}) : null,
  });
  const rank = (q: string, rows: SearchRow[], quick = false) =>
    rankSearch(q, parse(q), rows, async () => new Set(), { quick });
  const ids = (o: { items: Array<{ row: SearchRow }> }) => o.items.map((i) => i.row.capture_id);

  it("keeps photos covered enough by every word, most covered first", async () => {
    const rows = [
      row("low", { colors: { purple: 8 }, labels: { tree: 30 } }, 5),
      row("high", { colors: { purple: 40 }, labels: { plant: 10 } }),
      row("few", { colors: { purple: 2 }, labels: { tree: 60 } }),
      row("bare", { colors: { purple: 50 } }),
    ];
    expect(ids(await rank("purple", rows))).toEqual(["bare", "high", "low"]);
    expect(ids(await rank("purple leaves", rows))).toEqual(["high", "low"]);
  });

  it("judges photos without scene data by CLIP, and only those", async () => {
    clip.photos.set("unread-purple", new Float32Array([1, 0]));
    clip.photos.set("unread-other", new Float32Array([0, 1]));
    clip.photos.set("read-other", new Float32Array([1, 0])); // CLIP would match, the scene model says no
    const rows = [row("unread-purple", null), row("unread-other", null), row("read-other", { colors: { green: 90 } })];
    expect(ids(await rank("purple", rows))).toEqual(["unread-purple"]);
    const quick = await rank("purple", rows, true);
    expect(ids(quick)).toEqual([]);
    expect(quick.pending).toBe(true);
  });

  it("reads a half-typed word that starts a colour and a species as either", async () => {
    const parsed = parse("gre");
    expect(parsed.labels.scenes).toEqual(["green or grey"]);
    expect(parsed.scenes[0].orSpecies).toEqual([idOf("Great Blue Heron")]);
    const heron = { ...row("heron", { labels: { water: 60 } }), species_id: idOf("Great Blue Heron") };
    const rows = [
      heron,
      row("green-moose", { colors: { green: 50 } }),
      row("gray-moose", { colors: { gray: 50 } }),
      row("brown-moose", { colors: { brown: 50 } }),
    ];
    expect(ids(await rank("gre", rows)).sort()).toEqual(["gray-moose", "green-moose", "heron"]);
    // Typing on only narrows: each finished word keeps its own photos.
    expect(ids(await rank("green", rows))).toEqual(["green-moose"]);
    expect(ids(await rank("grey", rows))).toEqual(["gray-moose"]);
  });

  it("reads a half-typed word that starts a scene and a colour as either", async () => {
    expect(parse("gra").labels.scenes).toEqual(["grass or gray"]);
    const rows = [
      row("grass", { labels: { grass: 40 } }),
      row("gray", { colors: { gray: 60 } }),
      row("sky", { labels: { sky: 90 } }),
    ];
    expect(ids(await rank("gra", rows)).sort()).toEqual(["grass", "gray"]);
  });

  it("finds nothing when no photo matches", async () => {
    expect(ids(await rank("snow", [row("a", { labels: { grass: 80 } })]))).toEqual([]);
  });
});
