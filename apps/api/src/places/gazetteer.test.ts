import { describe, expect, it } from "vitest";
import { joinPlaceParts, rankTowns } from "./gazetteer.js";

const town = (name: string, population: number, distanceM: number | null = null, exact = false, geonameId = 0) => ({
  geonameId: geonameId || name.length * 1000 + population,
  name,
  population,
  distanceM,
  exact,
});
const names = (towns: { name: string }[]) => towns.map((t) => t.name);

describe("rankTowns", () => {
  it("puts an exact name first, then bigger towns, then the shorter name", () => {
    expect(
      names(rankTowns([town("Princeton", 3000), town("Prince Albert", 35000), town("Prince", 10, null, true)])),
    ).toEqual(["Prince", "Prince Albert", "Princeton"]);
    expect(
      names(
        rankTowns([town("Ab", 100, null, false, 1), town("Abc", 100, null, false, 2), town("Aa", 100, null, false, 3)]),
      ),
    ).toEqual(["Aa", "Ab", "Abc"]);
  });

  it("with a point, lets a nearby small town beat a far big one, but not a big one next door", () => {
    const ranked = rankTowns([
      town("Prince Albert", 35000, 1_000_000),
      town("Prince George", 78000, 5_000),
      town("Prince Rupert", 12000, 50_000),
    ]);
    expect(names(ranked)).toEqual(["Prince George", "Prince Rupert", "Prince Albert"]);
  });

  it("drops a town listed twice", () => {
    expect(rankTowns([town("Tofino", 2000, 10, false, 7), town("Tofino", 2000, 10, false, 7)])).toHaveLength(1);
  });
});

describe("joinPlaceParts", () => {
  it("skips blanks and a part repeating the one before, and stays under 300 characters", () => {
    expect(joinPlaceParts(["Prince George", "British Columbia", "Canada"])).toBe(
      "Prince George, British Columbia, Canada",
    );
    expect(joinPlaceParts(["Singapore", "singapore", null, " "])).toBe("Singapore");
    expect(joinPlaceParts(["x".repeat(400)])).toHaveLength(300);
  });
});
