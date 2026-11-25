import { describe, expect, it } from "vitest";
import { groupTermFor, isGrowthFormQuery, parseListPhrase, singularQuery } from "@lifer/shared";

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

  it("keeps a group name with a joining word in it whole", () => {
    expect(parseListPhrase("birds of prey")).toEqual({ taxonQuery: "birds of prey", placeQuery: null, nearMe: false });
    expect(parseListPhrase("sharks and rays near Belize")).toMatchObject({
      taxonQuery: "sharks and rays",
      placeQuery: "Belize",
    });
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

describe("groupTermFor", () => {
  const orders = (q: string) => groupTermFor(q)?.predicate.orders;
  const families = (q: string) => groupTermFor(q)?.predicate.families;
  it("maps everyday group words to Lifer's taxa, plural or not, any case", () => {
    expect(orders("Raptors")).toEqual(["accipitriformes", "falconiformes", "strigiformes", "cathartiformes"]);
    expect(orders("birds of prey")).toEqual(orders("raptor"));
    expect(orders(" owl ")).toEqual(["strigiformes"]);
    expect(families("hawks and eagles")).toEqual(["accipitridae"]);
    expect(families("Hawk")).toEqual(["accipitridae"]);
    expect(families("warblers")).toContain("parulidae");
    expect(families("woodpeckers")).toEqual(["picidae"]);
    expect(families("hummingbirds")).toEqual(["trochilidae"]);
    expect(orders("waterfowl")).toEqual(["anseriformes"]);
    expect(orders("songbirds")).toEqual(["passeriformes"]);
    expect(orders("bats")).toEqual(["chiroptera"]);
    expect(orders("frogs")).toEqual(["anura"]);
    expect(families("snakes")).toContain("viperidae");
    expect(groupTermFor("sharks and rays")?.predicate.classes).toEqual(["elasmobranchii"]);
    expect(families("shorebirds")).toContain("scolopacidae");
  });

  it("keeps big cats to the big ones", () => {
    const big = groupTermFor("big cats")!.predicate;
    expect(big.families).toEqual(["felidae"]);
    expect(big.includeNameWords).toContain("leopard");
    expect(big.excludeNameWords).toEqual(["cat"]);
  });

  it("answers nothing for words that name no group", () => {
    expect(groupTermFor("zzz")).toBeUndefined();
    expect(groupTermFor("")).toBeUndefined();
  });
});
