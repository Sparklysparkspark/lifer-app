// Sea zones count literature-cited records; land checklists and DNA-based samples don't.
import { describe, expect, it } from "vitest";
import { REAL_BASIS_OF_RECORD, SEA_ZONE_BASIS_OF_RECORD } from "./buildRegionSpecies.js";

describe("SEA_ZONE_BASIS_OF_RECORD", () => {
  it("adds records cited from published literature to the usual record types", () => {
    expect(SEA_ZONE_BASIS_OF_RECORD).toEqual([...REAL_BASIS_OF_RECORD, "MATERIAL_CITATION"]);
  });

  it("leaves tissue and eDNA samples out, and keeps citations off land checklists", () => {
    expect(SEA_ZONE_BASIS_OF_RECORD).not.toContain("MATERIAL_SAMPLE");
    expect(REAL_BASIS_OF_RECORD).not.toContain("MATERIAL_CITATION");
  });
});
