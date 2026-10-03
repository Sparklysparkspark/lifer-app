import { describe, expect, it } from "vitest";
import { filterByQuery, matchScore, normalizeForSearch } from "./searchNormalize";

describe("normalizeForSearch", () => {
  it("strips accents, case and punctuation", () => {
    expect(normalizeForSearch("Rüppell's  Warbler")).toBe("ruppells warbler");
    expect(normalizeForSearch("Rüppell’s Warbler")).toBe("ruppells warbler");
    expect(normalizeForSearch("Black-capped Chickadee")).toBe("black capped chickadee");
    expect(normalizeForSearch("  Québec ")).toBe("quebec");
  });
});

describe("matchScore", () => {
  it("ranks exact over prefix over word prefix over substring", () => {
    expect(matchScore("Quebec", "québec")).toBe(4);
    expect(matchScore("Quebec City", "queb")).toBe(3);
    expect(matchScore("Great Blue Heron", "blue her")).toBe(2);
    expect(matchScore("Great Blue Heron", "lue")).toBe(1);
    expect(matchScore("Great Blue Heron", "owl")).toBe(-1);
  });

  it("treats hyphens as spaces", () => {
    expect(matchScore("Black-capped Chickadee", "black capped")).toBe(3);
  });
});

describe("filterByQuery", () => {
  const items = [{ name: "New Mexico" }, { name: "Mexico" }, { name: "Ontario" }];
  it("sorts the best match first and drops non-matches", () => {
    expect(filterByQuery(items, "mexico", (i) => [i.name]).map((i) => i.name)).toEqual(["Mexico", "New Mexico"]);
  });
  it("returns everything (capped) for an empty query", () => {
    expect(filterByQuery(items, " ", (i) => [i.name], 2)).toHaveLength(2);
  });
});
