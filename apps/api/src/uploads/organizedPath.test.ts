import path from "node:path";
import { describe, expect, it } from "vitest";
import { originalsFolder } from "./organizedPath.js";

const base = path.join(path.sep, "Library");
const osprey = { speciesFolderName: "Osprey", taxonClass: "aves", takenAt: null, subfolder: "RAW" as const };

describe("originalsFolder", () => {
  it("files by taxon and species, without year or location layers by default", () => {
    expect(originalsFolder(base, { ...osprey, organizeByYear: false })).toBe(path.join(base, "Birds", "Osprey", "RAW"));
  });

  it("puts a species with no taxon class under Other", () => {
    expect(originalsFolder(base, { ...osprey, taxonClass: null, organizeByYear: false, subfolder: "Video" })).toBe(
      path.join(base, "Other", "Osprey", "Video"),
    );
  });

  it("names an Other Taxa group in English by default, or Latin when the naming style asks", () => {
    const insect = { ...osprey, taxonClass: "insecta", inatIconicTaxon: "Insecta", organizeByYear: false };
    expect(originalsFolder(base, insect)).toBe(path.join(base, "Insects", "Osprey", "RAW"));
    expect(originalsFolder(base, { ...insect, namingStyles: ["latin"] })).toBe(
      path.join(base, "Insecta", "Osprey", "RAW"),
    );
  });

  it("title-cases an unknown taxon class when there's no iconic taxon to name it by", () => {
    expect(originalsFolder(base, { ...osprey, taxonClass: "arachnida", organizeByYear: false })).toBe(
      path.join(base, "Arachnida", "Osprey", "RAW"),
    );
  });

  it("goes by the camera's wall-clock year, whatever zone the server runs in", () => {
    const opts = {
      ...osprey,
      organizeByYear: true,
      takenAtWallClock: "2025-12-31T23:30:00",
      takenAt: new Date(2026, 0, 1, 12),
    };
    expect(originalsFolder(base, opts)).toBe(path.join(base, "Wildlife 2025", "Birds", "Osprey", "RAW"));
  });

  it("falls back to the capture time's year, then to Undated", () => {
    expect(originalsFolder(base, { ...osprey, organizeByYear: true, takenAt: new Date(2024, 5, 1) })).toBe(
      path.join(base, "Wildlife 2024", "Birds", "Osprey", "RAW"),
    );
    expect(originalsFolder(base, { ...osprey, organizeByYear: true })).toBe(
      path.join(base, "Wildlife Undated", "Birds", "Osprey", "RAW"),
    );
  });

  it("adds the place name as the top layer only when that's turned on and there is one", () => {
    const opts = { ...osprey, organizeByYear: false, locationLabel: "Kenai: Alaska/USA." };
    expect(originalsFolder(base, { ...opts, organizeByLocation: true })).toBe(
      path.join(base, "Kenai AlaskaUSA", "Birds", "Osprey", "RAW"),
    );
    expect(originalsFolder(base, { ...opts, organizeByLocation: false })).toBe(
      path.join(base, "Birds", "Osprey", "RAW"),
    );
    expect(originalsFolder(base, { ...opts, organizeByLocation: true, locationLabel: null })).toBe(
      path.join(base, "Birds", "Osprey", "RAW"),
    );
  });
});
