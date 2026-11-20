import { describe, expect, it } from "vitest";
import { regionForCountry } from "./packs";

describe("regionForCountry", () => {
  const regions = [
    { name: "Côte d'Ivoire", speciesCount: 10 },
    { name: "Norway", speciesCount: 5 },
  ];
  it("matches the country name ignoring case and accents", () => {
    expect(regionForCountry(regions, "norway")?.name).toBe("Norway");
    expect(regionForCountry(regions, "Cote d'Ivoire")?.name).toBe("Côte d'Ivoire");
  });
  it("is null for an unknown or missing country", () => {
    expect(regionForCountry(regions, "Atlantis")).toBeNull();
    expect(regionForCountry(regions, null)).toBeNull();
  });
});
