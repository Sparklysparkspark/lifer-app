import { describe, expect, it } from "vitest";
import { groupByScientificName, type KeywordMatchedSpecies } from "./matchByKeywords.js";

function species(overrides: Partial<KeywordMatchedSpecies> & { id: string; scientific_name: string }): KeywordMatchedSpecies {
  return { common_name: null, taxon_class: null, family: null, ...overrides };
}

describe("groupByScientificName", () => {
  it("returns an empty map for no rows", () => {
    expect(groupByScientificName([]).size).toBe(0);
  });

  it("groups a single row under its own scientific name", () => {
    const row = species({ id: "1", scientific_name: "Anas platyrhynchos" });
    const grouped = groupByScientificName([row]);
    expect(grouped.size).toBe(1);
    expect(grouped.get("Anas platyrhynchos")).toEqual([row]);
  });

  it("groups multiple rows (e.g. matched via common name AND an alias) under the same current name", () => {
    const rowA = species({ id: "1", scientific_name: "Pavo cristatus", common_name: "Indian Peafowl" });
    const rowB = species({ id: "1", scientific_name: "Pavo cristatus", common_name: "Peacock" });
    const grouped = groupByScientificName([rowA, rowB]);
    expect(grouped.size).toBe(1);
    expect(grouped.get("Pavo cristatus")).toHaveLength(2);
  });

  it("keeps genuinely distinct species in separate groups (ambiguous match)", () => {
    const a = species({ id: "1", scientific_name: "Species A" });
    const b = species({ id: "2", scientific_name: "Species B" });
    const grouped = groupByScientificName([a, b]);
    expect(grouped.size).toBe(2);
    expect([...grouped.keys()].sort()).toEqual(["Species A", "Species B"]);
  });
});
