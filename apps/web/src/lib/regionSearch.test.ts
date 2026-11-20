import { readFileSync } from "node:fs";
import type { RegionSummary } from "@lifer/shared";
import { describe, expect, it } from "vitest";
import { regionLabel, regionPartOf, searchRegions } from "./regionSearch";

// The pipeline's alias table, the same file that fills regions.aliases in the catalog.
const ALIASES = JSON.parse(
  readFileSync(
    new URL("../../../../packages/data-pipeline/data/reference/region-aliases.json", import.meta.url),
    "utf8",
  ),
) as Array<{ match: string[]; aliases: string[] }>;

const region = (id: string, name: string, parentId: string | null, extra: Partial<RegionSummary> = {}) =>
  ({
    id,
    name,
    parentId,
    ebirdRegionCode: null,
    boundaryGeoJson: null,
    hasChildren: false,
    hasScopedChecklist: true,
    sovereigntyGroup: null,
    isSovereignDependency: false,
    ...extra,
  }) satisfies RegionSummary;

// Every aliased region in one list, so each alias has to beat all the others' names and aliases.
const world = region("world", "World", null, { hasScopedChecklist: false });
const UK_PARTS = ["England", "Scotland", "Wales", "Northern Ireland"];
const ukId = `r${ALIASES.findIndex((a) => a.match[0] === "United Kingdom")}`;
// Scotland and Wales have aliases of their own, so they sit under the United Kingdom here too.
const aliased = ALIASES.map((a, i) =>
  region(`r${i}`, a.match[0], UK_PARTS.includes(a.match[0]) ? ukId : "world", { aliases: a.aliases }),
);
const parts = UK_PARTS.filter((name) => !aliased.some((r) => r.name === name)).map((name) =>
  region(name.toLowerCase(), name, ukId),
);
const all = [world, ...aliased, ...parts];
const byId = new Map(all.map((r) => [r.id, r]));

describe("searchRegions aliases", () => {
  for (const [i, entry] of ALIASES.entries()) {
    for (const alias of entry.aliases) {
      it(`"${alias}" finds ${entry.match[0]} first`, () => {
        expect(searchRegions(all, byId, alias, null)[0]?.id).toBe(aliased[i].id);
      });
    }
  }
});

describe("constituent countries", () => {
  for (const name of UK_PARTS) {
    it(`"${name}" finds ${name}, part of the United Kingdom`, () => {
      const hit = searchRegions(all, byId, name, null)[0];
      expect(hit?.name).toBe(name);
      expect(regionPartOf(byId, hit)).toBe("United Kingdom");
      expect(regionLabel(byId, hit)).toBe(`${name}, United Kingdom`);
    });
  }
});
