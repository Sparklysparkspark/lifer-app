import path from "node:path";
import { FOLDER_LAYOUT_PRESETS, type FolderLevel } from "@lifer/shared";
import { describe, expect, it } from "vitest";
import { originalsFolder } from "./organizedPath.js";

const base = path.join(path.sep, "Library");
const { species, year, date, trip, location } = FOLDER_LAYOUT_PRESETS;
const combined: FolderLevel[] = ["country", "province", "place", "wildlifeYear", "group", "species"];
const osprey = {
  layout: species,
  speciesFolderName: "Osprey",
  taxonClass: "aves",
  takenAt: null,
  subfolder: "RAW" as const,
};
// A photo with a value for every level.
const full = {
  ...osprey,
  taxonOrder: "Accipitriformes",
  family: "Pandionidae",
  tripName: "Alberta 2024",
  country: "Canada",
  province: "Alberta",
  locationLabel: "Pigeon Lake",
  takenAtWallClock: "2024-06-01T08:30:00",
};
const lib = (...parts: string[]) => path.join(base, ...parts);

describe("originalsFolder", () => {
  it("files by taxon and species by default", () => {
    expect(originalsFolder(base, osprey)).toBe(lib("Birds", "Osprey", "RAW"));
  });

  it("builds every preset", () => {
    expect(originalsFolder(base, { ...full, layout: species })).toBe(lib("Birds", "Osprey", "RAW"));
    expect(originalsFolder(base, { ...full, layout: year })).toBe(lib("Wildlife 2024", "Birds", "Osprey", "RAW"));
    expect(originalsFolder(base, { ...full, layout: date })).toBe(lib("2024", "2024-06-01", "RAW"));
    expect(originalsFolder(base, { ...full, layout: trip })).toBe(
      lib("Trips", "Alberta 2024", "Birds", "Osprey", "RAW"),
    );
    expect(originalsFolder(base, { ...full, layout: location })).toBe(
      lib("Canada", "Alberta", "Pigeon Lake", "Birds", "Osprey", "RAW"),
    );
    // Both old switches on, as the migration maps it.
    expect(originalsFolder(base, { ...full, layout: combined })).toBe(
      lib("Canada", "Alberta", "Pigeon Lake", "Wildlife 2024", "Birds", "Osprey", "RAW"),
    );
  });

  it("builds custom orders, with month, order and family levels", () => {
    expect(originalsFolder(base, { ...full, layout: ["species", "year", "month"] })).toBe(
      lib("Osprey", "2024", "2024-06", "RAW"),
    );
    expect(originalsFolder(base, { ...full, layout: ["group", "order", "family", "species", "date"] })).toBe(
      lib("Birds", "Accipitriformes", "Pandionidae", "Osprey", "2024-06-01", "RAW"),
    );
  });

  it("skips a level the photo has no value for", () => {
    const every: FolderLevel[] = ["trip", "country", "province", "place", "year", "order", "group", "species"];
    expect(originalsFolder(base, { ...osprey, layout: every })).toBe(lib("Birds", "Osprey", "RAW"));
    // No trip: the Trip preset falls back to the Species layout.
    expect(originalsFolder(base, { ...full, tripName: null, layout: trip })).toBe(lib("Birds", "Osprey", "RAW"));
    expect(originalsFolder(base, { ...full, province: null, locationLabel: null, layout: location })).toBe(
      lib("Canada", "Birds", "Osprey", "RAW"),
    );
    expect(originalsFolder(base, { ...full, country: null, province: null, layout: location })).toBe(
      lib("Pigeon Lake", "Birds", "Osprey", "RAW"),
    );
    // Undated: Date's folders go, but "Wildlife Undated" stays where it always was.
    expect(originalsFolder(base, { ...full, takenAtWallClock: null, layout: date })).toBe(lib("RAW"));
    expect(originalsFolder(base, { ...osprey, layout: year })).toBe(lib("Wildlife Undated", "Birds", "Osprey", "RAW"));
  });

  it("sanitises names from regions, place names, trips and the taxonomy", () => {
    const odd = {
      ...full,
      country: "Côte d'Ivoire",
      province: "Lagunes/Abidjan",
      locationLabel: "Kenai: Alaska/USA.",
      tripName: "Trip?*",
    };
    expect(originalsFolder(base, { ...odd, layout: ["trip", "country", "province", "place", "species"] })).toBe(
      lib("Trips", "Trip", "Côte d'Ivoire", "LagunesAbidjan", "Kenai AlaskaUSA", "Osprey", "RAW"),
    );
  });

  it("puts a species with no taxon class under Other", () => {
    expect(originalsFolder(base, { ...osprey, taxonClass: null, subfolder: "Video" })).toBe(
      lib("Other", "Osprey", "Video"),
    );
  });

  it("names an Other Taxa group in English by default, or Latin when the naming style asks", () => {
    const insect = { ...osprey, taxonClass: "insecta", inatIconicTaxon: "Insecta" };
    expect(originalsFolder(base, insect)).toBe(lib("Insects", "Osprey", "RAW"));
    expect(originalsFolder(base, { ...insect, namingStyles: ["latin"] })).toBe(lib("Insecta", "Osprey", "RAW"));
  });

  it("title-cases an unknown taxon class when there's no iconic taxon to name it by", () => {
    expect(originalsFolder(base, { ...osprey, taxonClass: "arachnida" })).toBe(lib("Arachnida", "Osprey", "RAW"));
  });

  it("goes by the camera's wall-clock date, whatever zone the server runs in", () => {
    const opts = { ...osprey, takenAtWallClock: "2025-12-31T23:30:00", takenAt: new Date(2026, 0, 1, 12) };
    expect(originalsFolder(base, { ...opts, layout: year })).toBe(lib("Wildlife 2025", "Birds", "Osprey", "RAW"));
    expect(originalsFolder(base, { ...opts, layout: date })).toBe(lib("2025", "2025-12-31", "RAW"));
  });

  it("falls back to the capture time's date", () => {
    const opts = { ...osprey, takenAt: new Date(2024, 5, 1) };
    expect(originalsFolder(base, { ...opts, layout: year })).toBe(lib("Wildlife 2024", "Birds", "Osprey", "RAW"));
    expect(originalsFolder(base, { ...opts, layout: date })).toBe(lib("2024", "2024-06-01", "RAW"));
  });
});
