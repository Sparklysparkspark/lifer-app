import { describe, expect, it } from "vitest";
import { parseArgs, resumeArgv, NO_SNAPSHOT_STAGES } from "./refresh.js";

describe("refresh parseArgs", () => {
  it("runs requested stages in pipeline order", () => {
    expect(parseArgs(["--stages=publish,gate,packs", "--publish"]).stages).toEqual(["packs", "gate", "publish"]);
  });

  it("leaves publish out unless asked", () => {
    expect(parseArgs([]).stages).not.toContain("publish");
    expect(parseArgs(["--publish"]).stages.at(-1)).toBe("publish");
  });

  it("cuts maps only with a map source", () => {
    expect(parseArgs([]).stages).not.toContain("maps");
    const run = parseArgs(["--map-source=https://example.org/planet.pmtiles"]);
    expect(run.stages.slice(run.stages.indexOf("packs"), run.stages.indexOf("gate") + 1)).toEqual([
      "packs",
      "maps",
      "gate",
    ]);
    expect(() => parseArgs(["--stages=maps"])).toThrow(/--map-source/);
  });

  it("applies the shared iNaturalist taxa fix only when asked", () => {
    expect(parseArgs([]).fixSharedInatTaxa).toBe(false);
    expect(parseArgs(["--fix-shared-inat-taxa"]).fixSharedInatTaxa).toBe(true);
  });

  it("takes only stages the gate checks for freshness in --accept-stale", () => {
    expect(parseArgs(["--accept-stale=tiers,vectors"]).acceptStale).toEqual(["tiers", "vectors"]);
    expect(() => parseArgs(["--accept-stale=packs"])).toThrow(/--accept-stale takes/);
  });

  it("runs --replace-sea-zones only with the regions stage", () => {
    expect(parseArgs(["--stages=regions,packs", "--replace-sea-zones"]).replaceSeaZones).toBe(true);
    expect(() => parseArgs(["--stages=packs,gate", "--replace-sea-zones"])).toThrow(/add regions/);
  });

  it("keeps the province lists only in a regions run over every country", () => {
    expect(parseArgs(["--stages=regions", "--keep-provinces"]).keepProvinces).toBe(true);
    expect(() => parseArgs(["--stages=tiers", "--keep-provinces"])).toThrow(/regions/);
    expect(() => parseArgs(["--stages=regions", "--keep-provinces", "--countries=Canada"])).toThrow(/countries/);
  });

  it("refuses an unknown stage", () => {
    expect(() => parseArgs(["--stages=packs,pubish"])).toThrow(/Unknown stage "pubish"/);
  });

  it("runs the gazetteer after places, and a gazetteer-only run takes no database snapshot", () => {
    expect(parseArgs(["--stages=endemic,gazetteer,places"]).stages).toEqual(["places", "gazetteer", "endemic"]);
    expect(NO_SNAPSHOT_STAGES).toContain("gazetteer");
    expect(NO_SNAPSHOT_STAGES).not.toContain("places");
  });
});

describe("resumeArgv", () => {
  it("lets a value given now win over the resumed run's", () => {
    const argv = resumeArgv(
      ["--resume", "--countries=Canada", "--stages=gate"],
      ["--countries=Mexico", "--stages=packs", "--publish"],
    );
    const opts = parseArgs(argv);
    expect(opts.countries).toEqual(["Canada"]);
    expect(opts.stages).toEqual(["gate"]);
    expect(opts.publish).toBe(true);
  });

  it("keeps the resumed run's flags and adds new ones", () => {
    expect(resumeArgv(["--resume", "--allow-tier-skip"], ["--resume", "--publish"])).toEqual([
      "--resume",
      "--allow-tier-skip",
      "--publish",
    ]);
  });
});
