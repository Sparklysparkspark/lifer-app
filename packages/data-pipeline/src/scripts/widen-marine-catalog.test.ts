import { describe, expect, it } from "vitest";
import type { NewSpecies } from "./add-missing-species.js";
import { mergeSpeciesFile, parseStages, topUpBlocker, widenedOnly } from "./widen-marine-catalog.js";

describe("topUpBlocker", () => {
  it("blocks while the supervisor or a top-up process is alive", () => {
    expect(topUpBlocker({ state: "running", supervisor_pid: 55002 }, true, false)).toMatch(/pid 55002/);
    expect(topUpBlocker(null, false, true)).toMatch(/in progress/);
  });

  it("blocks an unfinished top-up even when nothing runs (stopped for disk, backing off)", () => {
    expect(topUpBlocker({ state: "stopped-low-disk" }, false, false)).toMatch(/not finished/);
    expect(topUpBlocker({ state: "backing-off" }, false, false)).toMatch(/not finished/);
  });

  it("lets a finished top-up, or none ever started, through", () => {
    expect(topUpBlocker({ state: "done" }, false, false)).toBeNull();
    expect(topUpBlocker(null, false, false)).toBeNull();
  });
});

describe("parseStages", () => {
  it("runs every stage in pipeline order, whatever order they were typed in", () => {
    expect(parseStages([])).toEqual(["species", "checklists", "audit", "tiers", "photos", "vectors"]);
    expect(parseStages(["--stages=tiers,species"])).toEqual(["species", "tiers"]);
  });

  it("refuses an unknown stage", () => {
    expect(() => parseStages(["--stages=packs"])).toThrow(/Unknown stage/);
  });
});

describe("widenedOnly", () => {
  const sp = (clade: string | null): NewSpecies => ({
    scientificName: "X y",
    commonName: null,
    taxonClass: "marine_mollusks",
    clade,
    inatTaxonId: 1,
    ebirdCode: null,
    family: null,
    order: null,
    gbifKey: -1,
    source: "inat",
    places: 1,
    inatObservations: 1,
  });

  it("keeps only the widened marine clades, not birds or the old shell orders", () => {
    expect(widenedOnly([sp("Bivalvia"), sp("Neogastropoda"), sp("Aves"), sp(null)]).map((s) => s.clade)).toEqual([
      "Bivalvia",
    ]);
  });
});

describe("mergeSpeciesFile", () => {
  it("keeps earlier runs' ids and adds new ones once", () => {
    expect(mergeSpeciesFile("a\nb\n", ["b", "c"])).toBe("a\nb\nc\n");
    expect(mergeSpeciesFile("", [])).toBe("\n");
  });
});
