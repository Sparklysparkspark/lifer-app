import { describe, expect, it } from "vitest";
import { isGrowthFormQuery, parseListPhrase, singularQuery } from "@lifer/shared";

describe("parseListPhrase", () => {
  it.each([
    ["pine trees of BC", "pine trees", "BC"],
    ["spiders in Canada", "spiders", "Canada"],
    ["butterflies near Ontario", "butterflies", "Ontario"],
    ["moths around  Lake Erie ", "moths", "Lake Erie"],
    ["bees from british columbia", "bees", "british columbia"],
    // The last joining word splits, so a taxon name with "of" in it survives.
    ["birds of prey of Canada", "birds of prey", "Canada"],
  ])("%s", (input, taxonQuery, placeQuery) => {
    expect(parseListPhrase(input)).toEqual({ taxonQuery, placeQuery, nearMe: false });
  });

  it("reads a phrase with no place as a taxon only", () => {
    expect(parseListPhrase(" dragonflies ")).toEqual({ taxonQuery: "dragonflies", placeQuery: null, nearMe: false });
    expect(parseListPhrase("of Canada")).toEqual({ taxonQuery: "of Canada", placeQuery: null, nearMe: false });
  });

  it("reads near me as a point, not a place", () => {
    expect(parseListPhrase("butterflies near me")).toEqual({
      taxonQuery: "butterflies",
      placeQuery: null,
      nearMe: true,
    });
    expect(parseListPhrase("spiders around here")).toMatchObject({ nearMe: true });
  });
});

describe("singularQuery", () => {
  it.each([
    ["butterflies", "butterfly"],
    ["moths", "moth"],
    ["finches", "finch"],
    ["grass", "grass"],
    ["Fungi", "Fungi"],
  ])("%s -> %s", (q, out) => expect(singularQuery(q)).toBe(out));
});

describe("isGrowthFormQuery", () => {
  it("flags growth forms iNaturalist resolves to the wrong group", () => {
    expect(isGrowthFormQuery("Trees")).toBe(true);
    expect(isGrowthFormQuery("wildflowers")).toBe(true);
    expect(isGrowthFormQuery("pine trees")).toBe(false);
  });
});
