// SeaZoneTally and decideZoneChecklist: the offline sea-zone rules match the live path's.
import { describe, expect, it } from "vitest";
import { SeaZoneTally, decideZoneChecklist, SAMPLE_POINTS, type ChecklistInputs } from "./sea-zone-checklist.js";
import type { Point } from "@lifer/core/lib/geometry.js";

function inputs(overrides: Partial<ChecklistInputs> = {}): ChecklistInputs {
  return { highTierNoPhoto: new Set(), globalCount: new Map(), looksInland: async () => false, ...overrides };
}

describe("SeaZoneTally", () => {
  it("sums record counts per zone and species and keeps a bounded set of distinct points", () => {
    const tally = new SeaZoneTally();
    for (let i = 0; i < SAMPLE_POINTS + 10; i++) tally.add(0, "cod", [i, 50], 2);
    tally.add(0, "cod", [0, 50], 5); // a repeated location adds records, not a point
    tally.add(1, "cod", [3, 3], 1);
    const cod = tally.byZone.get(0)!.get("cod")!;
    expect(cod.recordCount).toBe((SAMPLE_POINTS + 10) * 2 + 5);
    expect(cod.points).toHaveLength(SAMPLE_POINTS);
    expect(tally.byZone.get(1)!.get("cod")!.recordCount).toBe(1);
  });
});

describe("decideZoneChecklist", () => {
  const tallies = (entries: Array<[string, number]>) =>
    new Map(entries.map(([id, recordCount]) => [id, { recordCount, points: [[1, 1]] as Point[] }]));

  it("keeps a well-recorded species without any checks", async () => {
    const looksInland = async () => true;
    const kept = await decideZoneChecklist(tallies([["common", 40]]), inputs({ looksInland }));
    expect(kept).toEqual([{ speciesId: "common", recordCount: 40 }]);
  });

  it("drops a low-count species whose sample points are mostly inland", async () => {
    const kept = await decideZoneChecklist(tallies([["carp", 3]]), inputs({ looksInland: async () => true }));
    expect(kept).toEqual([]);
  });

  it("drops a low-count species with only a sliver of a large global record (a likely misidentification)", async () => {
    const globalCount = new Map([
      ["stray", 10_000],
      ["rare", 30],
    ]);
    const kept = await decideZoneChecklist(
      tallies([
        ["stray", 2],
        ["rare", 2],
      ]),
      inputs({ globalCount }),
    );
    // "rare" has few records anywhere, so two here aren't suspicious.
    expect(kept.map((k) => k.speciesId)).toEqual(["rare"]);
  });

  it("runs the inland check at any count for a high-tier species with no photo, but not the outlier check", async () => {
    const globalCount = new Map([["shark", 1_000_000]]);
    const kept = await decideZoneChecklist(
      tallies([["shark", 12]]),
      inputs({ highTierNoPhoto: new Set(["shark"]), globalCount }),
    );
    expect(kept).toEqual([{ speciesId: "shark", recordCount: 12 }]);
    const inland = await decideZoneChecklist(
      tallies([["shark", 12]]),
      inputs({ highTierNoPhoto: new Set(["shark"]), looksInland: async () => true }),
    );
    expect(inland).toEqual([]);
  });

  it("never treats a species with no known global count as an outlier", async () => {
    const kept = await decideZoneChecklist(tallies([["unknown", 1]]), inputs());
    expect(kept).toEqual([{ speciesId: "unknown", recordCount: 1 }]);
  });

  it("leaves off a species WoRMS records only in fresh water, however many records it has", async () => {
    const kept = await decideZoneChecklist(
      tallies([
        ["pike", 400],
        ["cod", 400],
      ]),
      inputs({ freshwaterOnly: new Set(["pike"]) }),
    );
    expect(kept.map((k) => k.speciesId)).toEqual(["cod"]);
  });

  it("keeps a marine outlier that a neighbouring zone has well recorded (the edge of its range)", async () => {
    const globalCount = new Map([
      ["baskingShark", 20_000],
      ["wrongOceanSkate", 20_000],
    ]);
    const kept = await decideZoneChecklist(
      tallies([
        ["baskingShark", 2],
        ["wrongOceanSkate", 2],
      ]),
      inputs({
        globalCount,
        marineOrBrackish: new Set(["baskingShark", "wrongOceanSkate"]),
        establishedNearby: (id) => id === "baskingShark",
      }),
    );
    expect(kept.map((k) => k.speciesId)).toEqual(["baskingShark"]);
  });

  it("doesn't rescue an outlier WoRMS hasn't called marine, even when a neighbour has it", async () => {
    const kept = await decideZoneChecklist(
      tallies([["stray", 2]]),
      inputs({ globalCount: new Map([["stray", 20_000]]), establishedNearby: () => true }),
    );
    expect(kept).toEqual([]);
  });
});
