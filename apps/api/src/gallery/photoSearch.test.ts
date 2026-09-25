import { describe, expect, it } from "vitest";
import { parseSearchQuery, type SpeciesEntry, type PlaceEntry } from "./photoSearch.js";

let n = 0;
function sp(commonName: string, scientificName: string, taxonClass: string, taxonOrder: string, family: string, aliases: string[] = [], codes: string[] = []): SpeciesEntry {
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
const parse = (q: string) => parseSearchQuery(q, { species, places, latinGroups: new Map([["anatidae", { families: ["anatidae"] }]]), now: new Date("2026-09-25") });

describe("parseSearchQuery", () => {
  it("reads a word that's only a describing word in a name as a picture description", () => {
    const p = parse("flying");
    expect(p.speciesIds).toBeNull();
    expect(p.description).toBe("flying");
    expect(p.hintSpeciesIds.has(idOf("Northern Flying Squirrel"))).toBe(true);

    const snow = parse("snow");
    expect(snow.speciesIds).toBeNull();
    expect(snow.hintSpeciesIds.has(idOf("Snow Goose"))).toBe(true);
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
  });

  it("describes a partial word by the picture word it's heading for", () => {
    const fly = parse("fly");
    expect(fly.speciesIds).toBeNull();
    expect(fly.description).toBe("flying");
    expect(fly.hintSpeciesIds.has(idOf("Northern Flying Squirrel"))).toBe(true);
    expect(parse("duck swim").description).toBe("duck swimming");
    expect(parse("flying").description).toBe("flying"); // already complete
  });

  it("in the full search, mixes a partial word's species into the picture results instead", () => {
    const full = parseSearchQuery("moo", { species, places, latinGroups: new Map() }, { partialWordPicksSpecies: false });
    expect(full.speciesIds).toBeNull();
    expect(full.hintSpeciesIds.has(idOf("Moose"))).toBe(true);
    expect(full.description).toBe("moo");
    const woodp = parseSearchQuery("woodp", { species, places, latinGroups: new Map() }, { partialWordPicksSpecies: false });
    expect(woodp.hintSpeciesIds.has(idOf("Northern Flicker"))).toBe(true); // in the woodpecker family
  });

  it("keeps the subject in the picture description", () => {
    const p = parse("mallard swimming in Ontario");
    expect([...p.speciesIds!]).toEqual([idOf("Mallard")]);
    expect(p.description).toBe("mallard swimming");
  });
});
