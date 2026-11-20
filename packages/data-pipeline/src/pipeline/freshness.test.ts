import { describe, expect, it } from "vitest";
import { staleStages, type StageTimes } from "./freshness.js";

const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const times = (entries: Record<string, number>): StageTimes =>
  new Map(Object.entries(entries).map(([stage, day]) => [stage, at(day)]));
const allFresh = { catalog: 10, enrich: 10, regions: 5, endemic: 6, tiers: 7, vectors: 11 };

describe("staleStages", () => {
  it("passes when every stage is newer than what it reads", () => {
    expect([...staleStages(times(allFresh), { gbifDownloads: at(4), zipNames: at(4) })]).toEqual([]);
  });

  it("flags tiers older than the regions run they read", () => {
    const stale = staleStages(times({ ...allFresh, regions: 8 }), {});
    expect([...stale.keys()]).toEqual(["tiers"]);
    expect(stale.get("tiers")).toContain("older than regions");
  });

  it("flags vectors older than catalog or enrich", () => {
    expect([...staleStages(times({ ...allFresh, enrich: 12 }), {}).keys()]).toEqual(["vectors"]);
  });

  it("flags the stages a newer GBIF download feeds", () => {
    expect([...staleStages(times(allFresh), { gbifDownloads: at(9) }).keys()]).toEqual(["regions", "endemic", "tiers"]);
    expect([...staleStages(times(allFresh), { zipNames: at(11) }).keys()]).toEqual(["catalog"]);
  });

  it("flags a stage that has never finished", () => {
    const { endemic: _, ...rest } = allFresh;
    expect(staleStages(times(rest), {}).get("endemic")).toBe("endemic has never finished");
  });
});
