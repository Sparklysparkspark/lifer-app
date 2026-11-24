import type { RegionSummary } from "@lifer/shared";
import { describe, expect, it } from "vitest";
import { regionCollapse } from "./regionCollapse";

const region = (id: string, name: string, parentId: string | null, scoped = true) =>
  ({ id, name, parentId, hasScopedChecklist: scoped }) as RegionSummary;
const REGIONS = [
  region("world", "World", null, false),
  region("af", "Africa", "world", false),
  region("eg", "Egypt", "af"),
  region("coast", "The Red Sea Coast", "eg"),
  region("bahr", "Al Bahr al Ahmar", "coast"),
  region("delta", "The Nile Delta", "eg"),
  region("giza", "Giza", "delta"),
  region("cairo", "Cairo", "delta"),
  // A one-province country never collapses: the country page is the pack's home.
  region("tiny", "Tiny", "af"),
  region("tiny-1", "Tiny Province", "tiny"),
];
const pairs = (rs: RegionSummary[]) => rs.map((r) => `${r.name}>${r.id}`);

describe("regionCollapse", () => {
  const c = regionCollapse(REGIONS, null);

  it("lists a one-province group by its name, opening the province; others as they are", () => {
    expect(pairs(c.areasOf("eg"))).toEqual(["The Red Sea Coast>bahr", "The Nile Delta>delta"]);
    expect(pairs(c.areasOf("delta"))).toEqual(["Giza>giza", "Cairo>cairo"]);
  });

  it("the group and the province are one page: same landing, no one-pill row, one name in the trail", () => {
    expect(c.target("coast")).toBe("bahr");
    expect(c.target("bahr")).toBe("bahr");
    expect(c.areasOf("coast")).toEqual([]);
    for (const id of ["coast", "bahr"]) {
      expect(pairs(c.trail(id))).toEqual(["World>world", "Africa>af", "Egypt>eg", "The Red Sea Coast>bahr"]);
    }
    expect(pairs(c.trail("giza")).at(-2)).toBe("The Nile Delta>delta");
  });

  it("never collapses hubs, or countries into a differently named area", () => {
    expect(c.target("tiny")).toBe("tiny");
    expect(pairs(c.areasOf("af"))).toContain("Tiny>tiny");
  });

  it("counts only available children: a group left with one counts as one", () => {
    const only = regionCollapse(REGIONS, new Set(["world", "af", "eg", "coast", "bahr", "delta", "giza"]));
    expect(pairs(only.areasOf("eg"))).toEqual(["The Red Sea Coast>bahr", "The Nile Delta>giza"]);
  });

  it("keeps a deeper level below a collapsed group, and collapses chains", () => {
    const deeper = regionCollapse([...REGIONS, region("b1", "North", "bahr"), region("b2", "South", "bahr")], null);
    expect(pairs(deeper.trail("b1")).slice(-2)).toEqual(["The Red Sea Coast>bahr", "North>b1"]);
    const chain = regionCollapse([...REGIONS, region("b1", "North", "bahr")], null);
    expect(chain.target("coast")).toBe("b1");
    expect(pairs(chain.trail("b1")).at(-1)).toBe("The Red Sea Coast>b1");
  });

  describe("a country's lone same-named area is the country", () => {
    const WITH_TWINS = [
      ...REGIONS,
      region("am", "Americas", "world", false),
      region("aw", "Aruba", "am"),
      region("aw-1", "Aruba", "aw"),
      region("cw", "Curaçao", "am"),
      region("cw-1", "CURACAO", "cw"),
      region("pr", "Puerto Rico", "am"),
      region("pr-1", "Puerto-Rico.", "pr"),
      region("lu", "Luxembourg", "eu"),
      region("lu-1", "Luxembourg", "lu"),
      region("lu-2", "Diekirch", "lu"),
      region("eu", "Europe", "world", false),
    ];
    const twins = regionCollapse(WITH_TWINS, null);

    it("lists no areas, opens the country, and names it once in the trail", () => {
      for (const [country, twin] of [
        ["aw", "aw-1"],
        ["cw", "cw-1"],
        ["pr", "pr-1"],
      ]) {
        expect(twins.target(twin)).toBe(country);
        expect(twins.target(country)).toBe(country);
        expect(twins.shownAs(twin)).toBe(country);
        expect(twins.areasOf(country)).toEqual([]);
        expect(twins.areasOf(twin)).toEqual([]);
        expect(twins.trail(twin).map((r) => r.id)).toEqual(["world", "am", country]);
      }
      expect(pairs(twins.areasOf("am"))).toEqual(["Aruba>aw", "Curaçao>cw", "Puerto Rico>pr"]);
    });

    it("keeps a same-named area that has a sibling, a lone area with another name, and an unavailable sibling counts as gone", () => {
      expect(twins.target("lu-1")).toBe("lu-1");
      expect(pairs(twins.areasOf("lu"))).toEqual(["Luxembourg>lu-1", "Diekirch>lu-2"]);
      expect(pairs(twins.trail("lu-1")).at(-1)).toBe("Luxembourg>lu-1");
      expect(c.target("tiny-1")).toBe("tiny-1");
      expect(pairs(c.areasOf("tiny"))).toEqual(["Tiny Province>tiny-1"]);
      const noSibling = regionCollapse(WITH_TWINS, new Set(["world", "eu", "lu", "lu-1"]));
      expect(noSibling.target("lu-1")).toBe("lu");
    });

    it("lists the twin's own areas under the country", () => {
      const deeper = regionCollapse(
        [...REGIONS, region("aw", "Aruba", "af"), region("aw-1", "Aruba", "aw"), region("n", "Noord", "aw-1")],
        null,
      );
      expect(pairs(deeper.areasOf("aw"))).toEqual(["Noord>n"]);
      expect(deeper.trail("n").map((r) => r.id)).toEqual(["world", "af", "aw", "n"]);
    });
  });

  it("leaves unknown ids alone", () => {
    expect(c.target("gone")).toBe("gone");
    expect(c.trail("gone")).toEqual([]);
  });
});
