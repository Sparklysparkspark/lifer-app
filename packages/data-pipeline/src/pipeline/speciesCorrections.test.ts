import { describe, expect, it } from "vitest";
import { loadSpeciesCorrections, parseSpeciesCorrections } from "./speciesCorrections.js";

describe("parseSpeciesCorrections", () => {
  it("accepts the shipped corrections file", () => {
    expect(loadSpeciesCorrections().length).toBeGreaterThan(0);
  });

  it("rejects entries without a name or a reason, and values of the wrong kind", () => {
    expect(() => parseSpeciesCorrections({})).toThrow(/array/);
    expect(() => parseSpeciesCorrections([{ reason: "x" }])).toThrow(/scientificName/);
    expect(() => parseSpeciesCorrections([{ scientificName: "A a" }])).toThrow(/reason/);
    expect(() => parseSpeciesCorrections([{ scientificName: "A a", reason: "x", iucnStatus: "XX" }])).toThrow(
      /IUCN code/,
    );
    expect(() => parseSpeciesCorrections([{ scientificName: "A a", reason: "x", commonName: "" }])).toThrow(
      /commonName/,
    );
    expect(() => parseSpeciesCorrections([{ scientificName: "A a", reason: "x", extinct: "no" }])).toThrow(/extinct/);
    expect(() => parseSpeciesCorrections([{ scientificName: "A a", reason: "x", endemicCountry: "ID" }])).toThrow(
      /endemicCountry/,
    );
  });

  it("keeps null for a status to clear, apart from one that's absent", () => {
    const [c] = parseSpeciesCorrections([{ scientificName: "A a", reason: "x", iucnStatus: null }]);
    expect(c.iucnStatus).toBeNull();
    const [d] = parseSpeciesCorrections([{ scientificName: "A a", reason: "x" }]);
    expect("iucnStatus" in d).toBe(false);
  });
});
