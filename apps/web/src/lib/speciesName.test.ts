import { describe, expect, it } from "vitest";
import { speciesDisplayName } from "./speciesName";

describe("speciesDisplayName", () => {
  it("prefers the common name in either casing", () => {
    expect(speciesDisplayName({ commonName: "Osprey", scientificName: "Pandion haliaetus" })).toBe("Osprey");
    expect(speciesDisplayName({ common_name: "Osprey", scientific_name: "Pandion haliaetus" })).toBe("Osprey");
  });

  it("falls back to the scientific name when the common name is missing or empty", () => {
    expect(speciesDisplayName({ scientificName: "Pandion haliaetus" })).toBe("Pandion haliaetus");
    expect(speciesDisplayName({ common_name: null, scientific_name: "Pandion haliaetus" })).toBe("Pandion haliaetus");
    expect(speciesDisplayName({ commonName: "", scientificName: "Pandion haliaetus" })).toBe("Pandion haliaetus");
  });
});
