import { describe, expect, it } from "vitest";
import { candidateNames, pickSuggestion } from "./unmatchedSuggestions.js";

describe("candidateNames", () => {
  it("takes the species folder, not the layout folders around it", () => {
    expect(candidateNames("Insects/Fuzzy-Horned Bumble Bee/Adjusted/_M8A5590.jpg", [])).toEqual([
      "Fuzzy-Horned Bumble Bee",
    ]);
    expect(candidateNames("Birds/Steller's Jay/2024/RAW/a.cr3", ["Cyanocitta stelleri"])).toEqual([
      "Cyanocitta stelleri",
      "Steller's Jay",
    ]);
    expect(candidateNames("a.jpg", [])).toEqual([]);
  });
});

describe("pickSuggestion", () => {
  const bee = { id: 1, name: "Bombus mixtus", rank: "species", preferred_common_name: "Fuzzy-horned Bumble Bee" };
  const other = {
    id: 2,
    name: "Bombus melanopygus",
    rank: "species",
    preferred_common_name: "Black-tailed Bumble Bee",
  };

  it("is exact when the name is the species' common or scientific name, whatever the case or hyphens", () => {
    expect(pickSuggestion("Fuzzy-Horned Bumble Bee", [other, bee])).toEqual({
      inatTaxonId: 1,
      scientificName: "Bombus mixtus",
      commonName: "Fuzzy-horned Bumble Bee",
      exact: true,
    });
    expect(pickSuggestion("bombus mixtus", [bee])?.exact).toBe(true);
  });

  it("offers the top species as a guess otherwise, and nothing without a species", () => {
    expect(pickSuggestion("fuzzy bee", [other, bee])).toMatchObject({ inatTaxonId: 2, exact: false });
    expect(pickSuggestion("bees", [{ id: 3, name: "Apidae", rank: "family" }])).toBeNull();
  });
});
