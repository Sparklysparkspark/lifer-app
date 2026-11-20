import { describe, expect, it } from "vitest";
import { duplicateCountries, loadAliasEntries, planAliases } from "./regionAliases.js";

const r = (id: string, name: string, parentId: string | null) => ({ id, name, parentId });
const regions = [
  r("w", "World", null),
  r("eu", "Europe", "w"),
  r("gb", "United Kingdom", "eu"),
  r("nl", "Netherlands", "eu"),
  r("tr", "Türkiye", "eu"),
  r("cz", "Czechia", "eu"),
  r("sc", "Scotland", "gb"),
];

describe("planAliases", () => {
  const plan = planAliases(regions, loadAliasEntries());
  const of = (id: string) => plan.aliases.get(id) ?? [];

  it("resolves each shipped alias to one region", () => {
    expect(of("nl")).toContain("Holland");
    expect(of("gb")).toEqual(expect.arrayContaining(["Britain", "UK"]));
    expect(of("tr")).toContain("Turkey");
    expect(of("cz")).toContain("Czech Republic");
    expect(of("sc")).toContain("Alba");
  });

  it("never lists a region's own name, and no alias belongs to two regions", () => {
    expect(of("cz")).not.toContain("Czechia");
    const all = [...plan.aliases.values()].flat().map((a) => a.toLowerCase());
    expect(new Set(all).size).toBe(all.length);
  });

  it("reports entries that match nothing and aliases that are another region's name", () => {
    const p = planAliases(
      [...regions, r("ho", "Holland", "eu")],
      [
        { match: ["Netherlands"], aliases: ["Holland"] },
        { match: ["Atlantis"], aliases: ["Lost"] },
      ],
    );
    expect(p.clashes).toEqual(["Holland (Netherlands)"]);
    expect(p.unmatched).toEqual([["Atlantis"]]);
  });
});

describe("duplicateCountries", () => {
  it("finds a country listed twice", () => {
    expect(duplicateCountries([...regions, r("a1", "Aruba", "eu"), r("a2", "Aruba", "eu")])).toEqual(["aruba"]);
  });
});
