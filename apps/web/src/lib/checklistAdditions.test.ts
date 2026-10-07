import { describe, expect, it } from "vitest";
import type { RegionSummary } from "@lifer/shared";
import { addedMessage, regionHasChecklist, seaZoneViewPath } from "./checklistAdditions";

function region(id: string, parentId: string | null, hasScopedChecklist: boolean): RegionSummary {
  return {
    id,
    name: id,
    parentId,
    ebirdRegionCode: null,
    boundaryGeoJson: null,
    hasChildren: false,
    hasScopedChecklist,
    sovereigntyGroup: null,
    isSovereignDependency: false,
  };
}

describe("regionHasChecklist", () => {
  const world = region("world", null, false);
  const continent = region("continent", "world", false);
  const country = region("country", "continent", true);
  const province = region("province", "country", true);
  // Natural Earth has a few subdivisions without a code; they still have a checklist.
  const uncoded = region("uncoded", "country", false);
  const byId = new Map([world, continent, country, province, uncoded].map((r) => [r.id, r]));

  it("allows countries and the regions inside them", () => {
    expect(regionHasChecklist(country, byId)).toBe(true);
    expect(regionHasChecklist(province, byId)).toBe(true);
    expect(regionHasChecklist(uncoded, byId)).toBe(true);
  });

  it("refuses World, continents and nothing picked", () => {
    expect(regionHasChecklist(world, byId)).toBe(false);
    expect(regionHasChecklist(continent, byId)).toBe(false);
    expect(regionHasChecklist(undefined, byId)).toBe(false);
  });
});

describe("addedMessage", () => {
  const yukon = { kind: "region" as const, name: "Yukon" };
  it("says what happened", () => {
    expect(addedMessage({ ok: true, added: true, alreadyOnChecklist: false }, "Moose", yukon)).toBe(
      "Added Moose to Yukon's checklist.",
    );
    expect(addedMessage({ ok: true, added: false, alreadyOnChecklist: false }, "Moose", yukon)).toBe(
      "You'd already added Moose to Yukon's checklist.",
    );
    expect(addedMessage({ ok: true, added: true, alreadyOnChecklist: true }, "Moose", yukon)).toBe(
      "Moose is already on Yukon's checklist.",
    );
  });

  it("names a sea zone's checklist", () => {
    expect(
      addedMessage({ ok: true, added: true, alreadyOnChecklist: false }, "Sea Otter", {
        kind: "seaZone",
        name: "Gulf of Alaska",
      }),
    ).toBe("Added Sea Otter to the Gulf of Alaska checklist.");
  });
});

describe("seaZoneViewPath", () => {
  const addition = { seaZoneId: "z1", seaZoneName: "Gulf of Alaska", addedAt: "", alreadyOnChecklist: false };
  it("opens a nearby region with only that zone's water", () => {
    expect(seaZoneViewPath({ ...addition, nearRegionId: "r1" })).toBe("/?region=r1&seaZones=z1&includeLand=0");
  });
  it("has nowhere to go without a nearby region", () => {
    expect(seaZoneViewPath({ ...addition, nearRegionId: null })).toBeNull();
  });
});
