import { describe, expect, it, vi } from "vitest";
import { parseSearchQuery, rankSearch, type SpeciesEntry, type PlaceEntry, type SearchRow } from "./photoSearch.js";
import { nameMatchScore } from "@lifer/shared";

// A two-dimensional stand-in for CLIP: "purple", "water", "huge" and "sunset" prompts point one
// way, everything else the other.
const clip = vi.hoisted(() => ({ photos: new Map<string, Float32Array>() }));
vi.mock("@lifer/core/species/textEmbedding.js", () => ({
  embedTextVectors: async (texts: string[]) =>
    texts.map(
      (t) => new Float32Array(["purple", "water", "huge", "sunset"].some((w) => t.includes(w)) ? [1, 0] : [0, 1]),
    ),
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
  sp("American Three-toed Woodpecker", "Picoides dorsalis", "aves", "Piciformes", "Picidae"),
  sp("Pileated Woodpecker", "Dryocopus pileatus", "aves", "Piciformes", "Picidae"),
  sp("Northern Flicker", "Colaptes auratus", "aves", "Piciformes", "Picidae", ["Wake-up"]),
  sp("Great Blue Heron", "Ardea herodias", "aves", "Pelecaniformes", "Ardeidae"),
  sp("Northern Flying Squirrel", "Glaucomys sabrinus", "mammalia", "Rodentia", "Sciuridae"),
  sp("Atlantic Cod", "Gadus morhua", "actinopterygii", "Gadiformes", "Gadidae", ["Fish", "Eating Fish"]),
  sp("Moose", "Alces alces", "mammalia", "Artiodactyla", "Cervidae"),
  sp("American Crow", "Corvus brachyrhynchos", "aves", "Passeriformes", "Corvidae"),
  sp("Common Raven", "Corvus corax", "aves", "Passeriformes", "Corvidae"),
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
  it("reads a count as how many animals, never as a species", () => {
    const p = parse("group of three");
    expect(p.speciesIds).toBeNull();
    expect(p.hintSpeciesIds.has(idOf("American Three-toed Woodpecker"))).toBe(false);
    expect(p.count).toMatchObject({ min: 3, max: 3, crowd: false });
    expect(p.description).toBeNull();
  });

  it("reads a picture word that's also in a name as a picture description", () => {
    const p = parse("flying");
    expect(p.speciesIds).toBeNull();
    expect(p.description).toBe("flying");
    expect(p.hintSpeciesIds.has(idOf("Northern Flying Squirrel"))).toBe(true);
  });

  it("picks species by a describing word of their name when nothing else is named", () => {
    expect([...parse("pileated").speciesIds!]).toEqual([idOf("Pileated Woodpecker")]);
    expect([...parse("great").speciesIds!]).toEqual([idOf("Great Blue Heron")]);
    // Beside another subject it only hints.
    const p = parse("crow great");
    expect([...p.speciesIds!]).toEqual([idOf("American Crow")]);
    expect(p.hintSpeciesIds.has(idOf("Great Blue Heron"))).toBe(true);
  });

  it("leaves out a species named after not, even by one word of its name", () => {
    const p = parse("woodpeckers not pileated");
    expect(p.labels.groups).toEqual(["woodpeckers"]);
    expect([...p.excludeSpeciesIds]).toEqual([idOf("Pileated Woodpecker")]);
  });

  it("reads a colour word as the colour or the species named with it", () => {
    const purple = [sp("Purple Finch", "Haemorhous purpureus", "aves", "Passeriformes", "Fringillidae")];
    const p = parseSearchQuery("purple", { species: [...species, ...purple], places, latinGroups: new Map() });
    expect(p.scenes[0].orSpecies).toEqual([purple[0].id]);
  });

  it("takes a full species name as the species", () => {
    expect([...parse("snow goose").speciesIds!]).toEqual([idOf("Snow Goose")]);
    expect([...parse("RTHA").speciesIds!]).toEqual([idOf("Red-Tailed Hawk")]);
  });

  it("uses a species' main noun, and old names only within the same family", () => {
    expect([...parse("hawk").speciesIds!]).toEqual([idOf("Red-Tailed Hawk")]); // not Peregrine ("Duck Hawk")
  });

  it("finds compound names by the end of their main noun, never mid-word or mid-name", () => {
    const extra = [
      sp("Northern Goshawk", "Astur atricapillus", "aves", "Accipitriformes", "Accipitridae"),
      sp("Southern Stingray", "Hypanus americanus", "elasmobranchii", "Myliobatiformes", "Dasyatidae"),
      sp("Gray Jay", "Perisoreus canadensis", "aves", "Passeriformes", "Corvidae"),
    ];
    const pick = (q: string) =>
      parseSearchQuery(q, { species: [...species, ...extra], places, latinGroups: new Map() }).speciesIds;
    expect([...pick("hawk")!].sort()).toEqual([idOf("Red-Tailed Hawk"), extra[0].id].sort());
    expect([...pick("hawks")!]).toContain(extra[0].id);
    expect([...pick("northern goshawk")!]).toEqual([extra[0].id]);
    // "jay" is a whole word; "ray" in Gray never counts (not the main noun).
    expect([...(pick("stingray") ?? [])]).toEqual([extra[1].id]);
    expect([...(pick("jay") ?? [])]).toEqual([extra[2].id]);
    expect(pick("pil")).not.toContain(extra[0].id);
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

  it("reads the user's place names alongside species and regions, ignoring case and accents", () => {
    const labels: PlaceEntry[] = [
      ...places,
      { kind: "location", id: "Pigeon Lake", name: "Pigeon Lake" },
      { kind: "location", id: "Île Bizard", name: "Île Bizard" },
    ];
    const pl = (q: string) => parseSearchQuery(q, { species, places: labels, latinGroups: new Map() });
    const p = pl("mallard Pigeon LAKE");
    expect([...p.speciesIds!]).toEqual([idOf("Mallard")]);
    expect(p.places).toEqual([{ kind: "location", id: "Pigeon Lake", name: "Pigeon Lake" }]);
    expect(p.description).toBeNull();
    expect(pl("ile bizard ontario").places.map((x) => x.name)).toEqual(["Île Bizard", "Ontario"]);
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
    expect(p.scenes).toEqual([{ label: "ponds", labels: ["water", "river", "lake", "sea"], min: 5 }]);
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

  it("keeps an in-between scene reading only when the picture agrees", async () => {
    clip.photos.set("sure", new Float32Array([0, 1]));
    clip.photos.set("pond", new Float32Array([1, 0]));
    clip.photos.set("green-blur", new Float32Array([0, 1]));
    const rows = [
      row("sure", { labels: { water: 80 } }),
      row("pond", { labels: { water: 28 } }),
      row("green-blur", { labels: { water: 30 } }),
      row("no-vector", { labels: { water: 20 } }),
    ];
    expect(ids(await rank("water", rows))).toEqual(["sure", "pond", "no-vector"]);
    // The quick pass shows only the sure one while the rest are checked.
    expect(ids(await rank("water", rows, true))).toEqual(["sure"]);
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

  it("puts the highest rated first for best and its synonyms, even with a description", async () => {
    clip.photos.set("fit", new Float32Array([0, 1]));
    const rows = [row("fit", null, 1), row("rated", null, 5)];
    expect(ids(await rank("moose sleeping", rows))).toEqual(["fit", "rated"]);
    expect(ids(await rank("my best moose sleeping shot", rows))).toEqual(["rated", "fit"]);
    expect(ids(await rank("favorite photos", [row("low", null, 2), row("high", null, 4)]))).toEqual(["high", "low"]);
  });
});

describe("last and this with seasons and months", () => {
  const at = (q: string, now: Date) => parseSearchQuery(q, { species, places, latinGroups: new Map(), now });
  const span = (q: string, now = new Date(2026, 9, 19)) =>
    at(q, now).dateRanges.map((r) => [r.from.toDateString(), r.to.toDateString()]);

  it("reads last as the latest one already over and this as the one ending this year", () => {
    expect(span("last spring")).toEqual([[new Date(2026, 2, 1).toDateString(), new Date(2026, 5, 1).toDateString()]]);
    expect(span("last december")).toEqual([
      [new Date(2025, 11, 1).toDateString(), new Date(2026, 0, 1).toDateString()],
    ]);
    expect(span("last october")).toEqual([[new Date(2025, 9, 1).toDateString(), new Date(2025, 10, 1).toDateString()]]);
    expect(span("last winter")).toEqual([[new Date(2025, 11, 1).toDateString(), new Date(2026, 2, 1).toDateString()]]);
    expect(span("this spring", new Date(2026, 3, 10))).toEqual([
      [new Date(2026, 2, 1).toDateString(), new Date(2026, 5, 1).toDateString()],
    ]);
    expect(span("last spring", new Date(2026, 3, 10))).toEqual([
      [new Date(2025, 2, 1).toDateString(), new Date(2025, 5, 1).toDateString()],
    ]);
  });

  it("keeps last and this out of the picture description", () => {
    const p = at("moose last spring", new Date(2026, 9, 19));
    expect(p.description).toBeNull();
    expect(p.months).toEqual([]);
    expect(p.labels.dates).toEqual(["last spring"]);
    expect(at("swimming this december", new Date(2026, 9, 19)).description).toBe("swimming");
    expect(parse("my best moose shot sleeping").description).toBe("moose sleeping");
  });

  it("reads best words as an ordering, but not top of", () => {
    const p = parse("my best moose shot");
    expect(p.bestFirst).toBe(true);
    expect(p.description).toBeNull();
    expect(p.labels.order).toEqual(["best first"]);
    expect(parse("moose on top of a hill").bestFirst).toBe(false);
  });
});

describe("counts and collective nouns", () => {
  it("reads a number before an animal as exactly that many of it", () => {
    const p = parse("3 birds");
    expect(p.labels.groups).toEqual(["birds"]);
    expect(p.count).toMatchObject({ min: 3, max: 3, about: null, prompt: "3 birds" });
    expect(p.description).toBeNull();
  });

  it("reads a larger number as roughly that many", () => {
    expect(parse("50 geese").count).toMatchObject({ min: 35, max: 70, about: 50 });
    expect(parse("pair of eagles").count).toMatchObject({ min: 2, max: 2 });
  });

  it("reads a collective noun with its own animal as a group of it", () => {
    const p = parse("murder of crows");
    // Any corvid, ravens included.
    expect(p.labels.groups).toEqual(["corvids"]);
    expect(p.speciesIds).toBeNull();
    expect(p.count).toMatchObject({ min: 2, max: null });
    expect(p.description).toBeNull();
    expect([...parse("unkindness of ravens").speciesIds!]).toEqual([idOf("Common Raven")]);
  });

  it("reads a collective noun with the wrong animal as the picture", () => {
    const p = parse("murder of ducks");
    expect(p.labels.groups).toEqual(["ducks"]);
    expect(p.count).toBeNull();
    expect(p.description).toContain("prey");
  });

  it("keeps an everyday collective word's meaning, with groups of its animal as hints", () => {
    const p = parse("murder");
    expect(p.speciesIds).toBeNull();
    expect(p.description).toContain("prey");
    expect(p.hintSpeciesIds).toEqual(new Set([idOf("American Crow"), idOf("Common Raven")]));
    expect(p.hintMinCount).toBe(2);
  });

  it("reads a word that's only a collective noun as a group of its animal", () => {
    const p = parse("gaggle");
    expect(p.labels.groups).toEqual(["geese"]);
    expect(p.count).toMatchObject({ min: 2, max: null });
  });

  it("reads a huge number as a crowd", () => {
    const p = parse("thousands of birds");
    expect(p.labels.groups).toEqual(["birds"]);
    expect(p.count).toMatchObject({ crowd: true, prompt: "a huge crowd of birds filling the frame" });
    expect(parse("huge flock").count).toMatchObject({ crowd: true });
  });
});

describe("rankSearch with counts", () => {
  const row = (id: string, count: number | null, name = "Moose"): SearchRow => {
    const s = species.find((x) => x.commonName === name)!;
    return {
      capture_id: id,
      species_id: s.id,
      quality_rating: 0,
      taken_at: null,
      tags: null,
      region_id: null,
      location_label: null,
      focal_length_mm: null,
      embedding_computed_at: "2026-01-01",
      common_name: s.commonName,
      scientific_name: s.scientificName,
      taxon_class: s.taxonClass,
      taxon_order: s.taxonOrder,
      family: s.family,
      subject_count: count,
    };
  };
  const rank = (q: string, rows: SearchRow[], quick = false) =>
    rankSearch(q, parse(q), rows, async () => new Set(), { quick });
  const ids = (o: { items: Array<{ row: SearchRow }> }) => o.items.map((i) => i.row.capture_id).sort();

  it("keeps counted photos with that many animals, and uncounted ones CLIP agrees with", async () => {
    clip.photos.set("n-crowd", new Float32Array([1, 0]));
    clip.photos.set("n-lone", new Float32Array([0, 1]));
    clip.photos.set("n-new", new Float32Array([0, 1]));
    const rows = [row("n-three", 3), row("n-one", 1), row("n-new", null)];
    expect(ids(await rank("three", rows))).toEqual(["n-three"]);
    const crowd = [row("n-big", 40), row("n-crowd", 2), row("n-lone", 1), row("n-new", null)];
    expect(ids(await rank("thousands", crowd))).toEqual(["n-big", "n-crowd"]);
    const quick = await rank("thousands", crowd, true);
    expect(ids(quick)).toEqual(["n-big"]);
    expect(quick.pending).toBe(true);
    expect((await rank("three", rows)).interpretation.count).toEqual({ min: 3, max: 3, about: null, crowd: false });
  });

  it("mixes in only groups of a collective's animal", async () => {
    const rows = [row("c-group", 3, "American Crow"), row("c-one", 1, "American Crow"), row("c-moose", 2)];
    expect(ids(await rank("murder", rows))).toEqual(["c-group"]);
  });
});

describe("filter, order and time words", () => {
  it("reads firsts and lifers, with places and dates", () => {
    const first = parse("my first moose");
    expect([...first.readings]).toEqual(["lifers"]);
    expect([...first.speciesIds!]).toEqual([idOf("Moose")]);
    expect(first.description).toBeNull();
    const inCanada = parse("lifers in canada");
    expect(inCanada.labels.readings).toEqual(["lifers"]);
    expect(inCanada.places.map((x) => x.name)).toEqual(["Canada"]);
    const newThisYear = parse("new species this year");
    expect(newThisYear.labels.readings).toEqual(["lifers"]);
    expect(newThisYear.years).toEqual([2026]);
    expect(newThisYear.description).toBeNull();
  });

  it("reads rarity words", () => {
    const rare = parse("rare owls");
    expect(rare.labels.readings).toEqual(["rare"]);
    expect(rare.labels.groups).toEqual(["owls"]);
    expect(parse("rarest").labels.readings).toEqual(["rarestFirst"]);
    expect(parse("endemics").labels.readings).toEqual(["endemic"]);
    expect(parse("legendary").labels.readings).toEqual(["legendary"]);
    expect(parse("uncommon ducks").labels.readings).toEqual(["uncommon"]);
    // A tier word inside a species name stays part of the name.
    const raven = parse("common raven");
    expect(raven.labels.readings).toEqual([]);
    expect([...raven.speciesIds!]).toEqual([idOf("Common Raven")]);
  });

  it("reads star ratings and filter words", () => {
    expect(parse("5 stars").stars).toEqual({ min: 5, max: 5 });
    expect(parse("4 star").stars).toEqual({ min: 4, max: 4 });
    const plus = parse("4+ stars moose");
    expect(plus.stars).toEqual({ min: 4, max: null });
    expect([...plus.speciesIds!]).toEqual([idOf("Moose")]);
    expect(plus.count).toBeNull();
    expect(parse("three stars or more").stars).toEqual({ min: 3, max: null });
    expect(parse("3 birds").stars).toBeNull();
    const words: Array<[string, string]> = [
      ["unrated", "unrated"],
      ["videos", "videos"],
      ["raw", "raw"],
      ["hidden", "hidden"],
      ["edited", "edited"],
      ["no location", "noLocation"],
      ["no region", "noLocation"],
      ["missing date", "noDate"],
      ["no date", "noDate"],
    ];
    for (const [q, reading] of words) {
      const p = parse(`${q} moose`);
      expect(p.labels.readings).toEqual([reading]);
      expect(p.description).toBeNull();
    }
  });

  it("leaves out what follows not or without", () => {
    const ducks = parse("ducks not mallards");
    expect(ducks.labels.groups).toEqual(["ducks"]);
    expect([...ducks.excludeSpeciesIds]).toEqual([idOf("Mallard")]);
    expect(ducks.labels.excluded).toEqual(["mallards"]);
    expect(ducks.description).toBeNull();
    const people = parse("birds without people");
    expect(people.labels.groups).toEqual(["birds"]);
    expect(people.excludeDescriptions).toEqual(["people"]);
    expect(people.description).toBeNull();
    expect(parse("birds except owls").excludeGroups.map((g) => g.label)).toEqual(["owls"]);
    // Nothing after it: dropped.
    expect(parse("moose not").description).toBeNull();
  });

  it("reads or as either", () => {
    const p = parse("owls or hawks");
    expect(p.labels.groups).toEqual(["owls"]);
    expect([...p.speciesIds!]).toEqual([idOf("Red-Tailed Hawk")]);
    const scenes = parse("snow or water");
    expect(scenes.scenes).toHaveLength(1);
    expect(scenes.labels.scenes).toEqual(["snow or water"]);
    expect(scenes.scenes[0].alternatives).toHaveLength(1);
  });

  it("reads newest and oldest, leaving last year a date", () => {
    expect(parse("latest owl").labels.readings).toEqual(["newestFirst"]);
    expect(parse("my last moose").labels.readings).toEqual(["newestFirst"]);
    const lastYear = parse("moose last year");
    expect(lastYear.labels.readings).toEqual([]);
    expect(lastYear.years).toEqual([2025]);
    const oldest = parse("oldest photo of a moose");
    expect(oldest.labels.readings).toEqual(["oldestFirst"]);
    expect([...oldest.speciesIds!]).toEqual([idOf("Moose")]);
  });

  it("reads camera models from the user's own photos only", () => {
    const cameras = ["Canon EOS R5m2", "Canon EOS R50", "iPhone 15 Pro"];
    const p = (q: string) => parseSearchQuery(q, { species, places, latinGroups: new Map(), cameras });
    expect(p("r5").cameras).toEqual(["Canon EOS R5m2"]);
    expect(p("iphone").cameras).toEqual(["iPhone 15 Pro"]);
    const shotOn = p("moose shot on r50");
    expect(shotOn.cameras).toEqual(["Canon EOS R50"]);
    expect([...shotOn.speciesIds!]).toEqual([idOf("Moose")]);
    expect(shotOn.description).toBeNull();
    expect(p("pro").cameras).toEqual([]);
    expect(p("r7").cameras).toEqual([]);
    expect(p("5 birds").cameras).toEqual([]);
  });

  it("reads times of day, unless they're part of a species name", () => {
    const sunset = parse("owls at sunset");
    expect(sunset.labels.readings).toEqual(["sunset"]);
    expect(sunset.labels.groups).toEqual(["owls"]);
    expect(sunset.description).toBeNull();
    expect(parse("golden hour").labels.readings).toEqual(["goldenHour"]);
    expect(parse("moose in the morning").labels.readings).toEqual(["morning"]);
    const heron = sp("Black-Crowned Night Heron", "Nycticorax nycticorax", "aves", "Pelecaniformes", "Ardeidae");
    const p = parseSearchQuery("night heron", { species: [...species, heron], places, latinGroups: new Map() });
    expect(p.labels.readings).toEqual([]);
    expect(p.speciesIds!.has(heron.id)).toBe(true);
  });
});

describe("shot type words", () => {
  const shot = (q: string) => {
    const p = parse(q);
    return { readings: p.labels.readings, description: p.description, groups: p.labels.groups };
  };

  it("reads action and framing words as the Shot type filter, not a picture description", () => {
    expect(shot("environmental flight")).toEqual({
      readings: ["environmental", "flying"],
      description: null,
      groups: [],
    });
    expect(shot("flight shots")).toEqual({ readings: ["flying"], description: null, groups: [] });
    expect(shot("close-up behaviour")).toEqual({ readings: ["close", "behavior"], description: null, groups: [] });
    expect(shot("closeup behavior")).toEqual({ readings: ["close", "behavior"], description: null, groups: [] });
    expect(shot("portraits")).toEqual({ readings: ["close"], description: null, groups: [] });
    expect(shot("habitat shot")).toEqual({ readings: ["environmental"], description: null, groups: [] });
    expect(shot("owls at rest").readings).toEqual(["resting"]);
  });

  it("keeps the subject beside them", () => {
    const p = shot("birds in flight");
    expect(p.readings).toEqual(["flying"]);
    expect(p.groups).toEqual(["birds"]);
    expect(p.description).toBeNull();
    const heron = parse("heron in flight");
    expect([...heron.speciesIds!]).toEqual([idOf("Great Blue Heron")]);
    expect(heron.labels.readings).toEqual(["flying"]);
  });
});

describe("photo styles", () => {
  it("asks CLIP for the style instead of the words typed", () => {
    const p = parse("high key");
    expect(p.labels.styles).toEqual(["high key"]);
    expect(p.description).toBe("a high-key photograph, bright and mostly white");
    expect(p.speciesIds).toBeNull();
    const owl = parse("backlit owls");
    expect(owl.labels.groups).toEqual(["owls"]);
    expect(owl.description).toBe("a backlit animal glowing with rim light owls");
    // Not a colour or a time.
    const golden = parse("golden light");
    expect(golden.scenes).toEqual([]);
    expect(golden.labels.styles).toEqual(["golden light"]);
  });

  it("reads black and white alone as the style, and with an animal as its colours", () => {
    const alone = parse("black and white");
    expect(alone.labels.styles).toEqual(["black and white"]);
    expect(alone.colorHint).toEqual(["black", "white"]);
    expect(alone.scenes).toEqual([]);
    const bird = parse("black and white bird");
    expect(bird.labels.styles).toEqual([]);
    expect(bird.labels.scenes).toEqual(["black", "white"]);
    const bw = parse("b&w moose");
    expect(bw.labels.styles).toEqual(["b&w"]);
    expect(bw.scenes).toEqual([]);
    expect(parse("monochrome").labels.styles).toEqual(["monochrome"]);
  });
});

describe("rankSearch with filter, order and time words", () => {
  const row = (id: string, extra: Partial<SearchRow> = {}, name = "Moose"): SearchRow => {
    const s = species.find((x) => x.commonName === name)!;
    return {
      capture_id: id,
      species_id: s.id,
      quality_rating: 0,
      taken_at: null,
      tags: null,
      region_id: "r-1",
      location_label: null,
      focal_length_mm: null,
      embedding_computed_at: "2026-01-01",
      common_name: s.commonName,
      scientific_name: s.scientificName,
      taxon_class: s.taxonClass,
      taxon_order: s.taxonOrder,
      family: s.family,
      ...extra,
    };
  };
  const rank = (q: string, rows: SearchRow[], cameras: string[] = []) =>
    rankSearch(
      q,
      parseSearchQuery(q, { species, places, latinGroups: new Map(), cameras, now: new Date("2026-09-25") }),
      rows,
      async () => new Set(),
    );
  const ids = (o: { items: Array<{ row: SearchRow }> }) => o.items.map((i) => i.row.capture_id);

  it("keeps lifers, rare and endemic species, and photos with no location", async () => {
    const rows = [
      row("first", { is_lifer: true, tier: "common" }),
      row("rare", { tier: "rare", is_endemic: true }),
      row("nowhere", { region_id: null, tier: "occasional" }),
    ];
    expect(ids(await rank("lifers", rows))).toEqual(["first"]);
    expect(ids(await rank("rare", rows))).toEqual(["rare"]);
    expect(ids(await rank("occasional", rows))).toEqual(["nowhere"]);
    expect(ids(await rank("endemic moose", rows))).toEqual(["rare"]);
    expect(ids(await rank("no location", rows))).toEqual(["nowhere"]);
    expect(ids(await rank("rarest moose", rows))).toEqual(["rare", "nowhere", "first"]);
    expect((await rank("lifers", rows)).interpretation.readings).toEqual(["lifers"]);
  });

  it("keeps photos from a named camera", async () => {
    const rows = [row("r5", { camera_model: "Canon EOS R5m2" }), row("phone", { camera_model: "iPhone 15 Pro" })];
    expect(ids(await rank("r5", rows, ["Canon EOS R5m2", "iPhone 15 Pro"]))).toEqual(["r5"]);
  });

  it("leaves out excluded species and photos that clearly show an excluded word", async () => {
    const rows = [row("duck", {}, "Wood Duck"), row("mallard", {}, "Mallard"), row("goose", {}, "Canada Goose")];
    expect(ids(await rank("ducks not mallards", rows))).toEqual(["duck"]);
    clip.photos.set("x-purple", new Float32Array([1, 0]));
    clip.photos.set("x-plain", new Float32Array([0, 1]));
    expect(ids(await rank("moose without purple", [row("x-purple"), row("x-plain")]))).toEqual(["x-plain"]);
  });

  it("puts the newest or oldest first and keeps the rest", async () => {
    const rows = [
      row("mid", { taken_at: "2024-05-01T10:00:00Z", quality_rating: 5 }),
      row("new", { taken_at: "2025-05-01T10:00:00Z", quality_rating: 1 }),
      row("old", { taken_at: "2020-05-01T10:00:00Z", quality_rating: 3 }),
      row("undated", { quality_rating: 4 }),
    ];
    expect(ids(await rank("latest moose", rows))).toEqual(["new", "mid", "undated", "old"]);
    expect(ids(await rank("oldest moose", rows))).toEqual(["old", "mid", "undated", "new"]);
  });

  it("places the sun for photos with coordinates, and asks CLIP about the rest", async () => {
    clip.photos.set("t-dusk", new Float32Array([0, 1]));
    clip.photos.set("t-noon", new Float32Array([1, 0]));
    clip.photos.set("t-sunset-look", new Float32Array([1, 0]));
    clip.photos.set("t-plain", new Float32Array([0, 1]));
    const greenwich = { lat: 51.4769, lon: 0 };
    const rows = [
      // Sunset in London on 2024-06-20 was 20:21 UTC.
      row("t-dusk", { ...greenwich, taken_at: "2024-06-20T20:15:00Z" }),
      row("t-noon", { ...greenwich, taken_at: "2024-06-20T12:00:00Z" }),
      row("t-sunset-look", { taken_at: "2024-06-20T12:00:00Z" }),
      row("t-plain"),
    ];
    expect(ids(await rank("moose at sunset", rows)).sort()).toEqual(["t-dusk", "t-sunset-look"]);
    expect(ids(await rank("moose at night", rows))).toEqual([]);
  });

  it("mixes black-and-white animals in below monochrome photos", async () => {
    const rows = [
      row("bw-animal", { scene_labels: {}, scene_colors: { black: 20, white: 30 } }),
      row("brown", { scene_labels: {}, scene_colors: { brown: 60 } }),
    ];
    expect(ids(await rank("black and white", rows))).toEqual(["bw-animal"]);
  });
});

describe("nameMatchScore", () => {
  const names = (common: string, sci = "") => [common, sci];
  it("needs every word in the same name, whole or as a word start", () => {
    expect(nameMatchScore(names("Pileated Woodpecker", "Dryocopus pileatus"), "pil")).toBeGreaterThan(0);
    expect(nameMatchScore(names("Black-capped Chickadee", "Poecile atricapillus"), "pil")).toBe(-1);
    expect(nameMatchScore(names("Purple Martin"), "purple finch")).toBe(-1);
    expect(nameMatchScore(names("Black-capped Chickadee"), "gr bl")).toBe(-1);
    expect(nameMatchScore(names("Great Blue Heron"), "gr bl her")).toBeGreaterThan(0);
  });

  it("reads plurals, irregular ones too", () => {
    expect(nameMatchScore(names("American Crow"), "crows")).toBeGreaterThan(0);
    expect(nameMatchScore(names("Red Fox"), "foxes")).toBeGreaterThan(0);
    expect(nameMatchScore(names("Gray Wolf"), "wolves")).toBeGreaterThan(0);
    expect(nameMatchScore(names("Snow Goose"), "geese")).toBeGreaterThan(0);
    expect(nameMatchScore(names("House Mouse"), "mice")).toBeGreaterThan(0);
  });

  it("ranks the whole name above whole words above word starts above compound endings", () => {
    const exact = nameMatchScore(names("Purple Finch"), "purple finch");
    const words = nameMatchScore(names("Purple Finch Hybrid"), "purple finch");
    const starts = nameMatchScore(names("Purple Finch"), "purp fin");
    expect(exact).toBeGreaterThan(words);
    expect(words).toBeGreaterThan(starts);
    const ray = nameMatchScore(names("Spotted Eagle Ray"), "ray");
    const rayStart = nameMatchScore(names("Rayfin Wrasse"), "ray");
    const stingray = nameMatchScore(names("Southern Stingray"), "ray");
    expect(ray).toBeGreaterThan(rayStart);
    expect(rayStart).toBeGreaterThan(stingray);
    expect(stingray).toBeGreaterThan(-1);
  });

  it("finds compound names by the end of their last word", () => {
    expect(nameMatchScore(names("Southern Stingray"), "ray")).toBeGreaterThan(-1);
    expect(nameMatchScore(names("Yellow Stingray"), "rays")).toBeGreaterThan(-1);
    expect(nameMatchScore(names("Roseate Spoonbill"), "bill")).toBeGreaterThan(-1);
    expect(nameMatchScore(names("Northern Goshawk"), "hawk")).toBeGreaterThan(-1);
    expect(nameMatchScore(names("Ruby-throated Hummingbird"), "bird")).toBeGreaterThan(-1);
    // Not mid-word, not two letters, not a word before the last ("ray" in Gray Jay).
    expect(nameMatchScore(names("Black-capped Chickadee", "Poecile atricapillus"), "pil")).toBe(-1);
    expect(nameMatchScore(names("Southern Stingray"), "ay")).toBe(-1);
    expect(nameMatchScore(names("Gray Jay"), "ray")).toBe(-1);
    // Scientific names and codes passed as prefixOnly only match from a word start.
    expect(nameMatchScore([], "ensis", ["Perisoreus canadensis"])).toBe(-1);
    expect(nameMatchScore([], "peri", ["Perisoreus canadensis"])).toBeGreaterThan(-1);
    expect(nameMatchScore(["Gray Jay"], "jay", ["Perisoreus canadensis"])).toBeGreaterThan(-1);
  });

  it("keeps every word of a multi-word query in one name, compounds included", () => {
    expect(nameMatchScore(names("Southern Stingray"), "southern ray")).toBeGreaterThan(-1);
    expect(nameMatchScore(names("Southern Stingray"), "yellow ray")).toBe(-1);
    expect(nameMatchScore(["Southern Stingray", "Yellow Tang"], "yellow ray")).toBe(-1);
  });
});
