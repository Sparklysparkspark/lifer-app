// Sea zones count literature-cited records; land checklists and DNA-based samples don't.
import { describe, expect, it } from "vitest";
import { countsForChecklist, REAL_BASIS_OF_RECORD, SEA_ZONE_BASIS_OF_RECORD } from "./buildRegionSpecies.js";

describe("SEA_ZONE_BASIS_OF_RECORD", () => {
  it("adds records cited from published literature to the usual record types", () => {
    expect(SEA_ZONE_BASIS_OF_RECORD).toEqual([...REAL_BASIS_OF_RECORD, "MATERIAL_CITATION"]);
  });

  it("counts sightings and museum specimens, never fossils, eDNA, citations or zoo animals", () => {
    for (const basis of ["HUMAN_OBSERVATION", "OBSERVATION", "MACHINE_OBSERVATION", "PRESERVED_SPECIMEN"])
      expect(countsForChecklist(basis)).toBe(true);
    for (const basis of [
      "FOSSIL_SPECIMEN",
      "MATERIAL_SAMPLE",
      "MATERIAL_CITATION",
      "LIVING_SPECIMEN",
      "OCCURRENCE",
      "",
    ])
      expect(countsForChecklist(basis)).toBe(false);
  });

  it("leaves tissue and eDNA samples out, and keeps citations off land checklists", () => {
    expect(SEA_ZONE_BASIS_OF_RECORD).not.toContain("MATERIAL_SAMPLE");
    expect(REAL_BASIS_OF_RECORD).not.toContain("MATERIAL_CITATION");
  });
});
