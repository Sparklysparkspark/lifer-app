import { describe, expect, it } from "vitest";
import { establishmentFromDistributions } from "./distributions.js";

describe("establishmentFromDistributions", () => {
  const GRIIS = "Global Register of Introduced and Invasive Species - Australia";

  it("reads countries from either field and sorts them by how the species got there", () => {
    expect(
      establishmentFromDistributions([
        { locationId: "iso:AU", establishmentMeans: "INTRODUCED", source: GRIIS },
        { country: "ID", establishmentMeans: "NATIVE" },
        { country: "NZ", establishmentMeans: "naturalised", source: GRIIS },
        { country: "AI" },
      ]),
    ).toEqual({ native: ["ID"], introduced: ["AU", "NZ"] });
  });

  it("takes introduced countries from the curated register only", () => {
    expect(
      establishmentFromDistributions([
        { country: "BO", establishmentMeans: "INTRODUCED", source: "Catálogo Taxonômico da Fauna do Brasil" },
      ]),
    ).toEqual({ native: [], introduced: [] });
  });

  it("skips a realm with no country", () => {
    expect(establishmentFromDistributions([{ establishmentMeans: "NATIVE" }])).toEqual({ native: [], introduced: [] });
  });
});
