import { describe, expect, it } from "vitest";
import {
  MARINE_MIN_RECORDS,
  binomial,
  freshwaterOrLandOnly,
  keepCandidates,
  marineBinomials,
  tallyZone,
} from "./sea-zone-marine.js";

describe("binomial", () => {
  it("drops subgenera and subspecies, and rejects a genus alone", () => {
    expect(binomial("Callyspongia (Cladochalina) plicifera")).toBe("Callyspongia plicifera");
    expect(binomial("Chelonia mydas agassizii")).toBe("Chelonia mydas");
    expect(binomial("Conus")).toBeNull();
  });
});

describe("tallyZone", () => {
  const names = new Map([
    ["Hypselodoris bayeri", "nudi"],
    ["Callyspongia plicifera", "sponge"],
    ["Chelonia mydas", "turtle"],
  ]);

  it("matches by name or accepted name, sums subspecies, and skips higher ranks", () => {
    const tally = tallyZone(
      [
        { scientificName: "Hypselodoris bayeri", taxonRank: "Species", records: 4, is_marine: true },
        { scientificName: "Callyspongia (Cladochalina) plicifera", taxonRank: "Species", records: 9 },
        { scientificName: "Chelonia mydas mydas", taxonRank: "Subspecies", records: 2 },
        { scientificName: "Chelonia agassizii", acceptedNameUsage: "Chelonia mydas", taxonRank: "Species", records: 3 },
        { scientificName: "Hypselodoris", taxonRank: "Genus", records: 50 },
      ],
      names,
    );
    expect(Object.fromEntries(tally)).toEqual({ nudi: 4, sponge: 9, turtle: 5 });
  });

  it("leaves out species OBIS flags as fresh water or land only, and collects marine ones", () => {
    const marine = new Set<string>();
    const tally = tallyZone(
      [
        { scientificName: "Hypselodoris bayeri", taxonRank: "Species", records: 4, is_marine: true },
        { scientificName: "Chelonia mydas", taxonRank: "Species", records: 7, is_marine: false, is_freshwater: true },
      ],
      names,
      marine,
    );
    expect([...tally.keys()]).toEqual(["nudi"]);
    expect([...marine]).toEqual(["nudi"]);
    expect(freshwaterOrLandOnly({ scientificName: "x", records: 1, is_terrestrial: true, is_brackish: true })).toBe(false);
  });
});

describe("keepCandidates", () => {
  it("keeps well recorded species, and rarely recorded ones only when photographed next to the zone", () => {
    const tally = new Map([
      ["common", MARINE_MIN_RECORDS],
      ["rare-photographed", 1],
      ["rare", MARINE_MIN_RECORDS - 1],
    ]);
    const kept = keepCandidates(3, tally, (id) => id === "rare-photographed");
    expect(kept).toEqual([
      { zone: 3, speciesId: "common", recordCount: MARINE_MIN_RECORDS },
      { zone: 3, speciesId: "rare-photographed", recordCount: 1 },
    ]);
  });
});

describe("marineBinomials", () => {
  it("takes names and accepted names OBIS flags marine or brackish, never freshwater-only ones", () => {
    const names = marineBinomials([
      { scientificName: "Mytilus edulis", records: 3, is_marine: true },
      { scientificName: "Neritina virginea", acceptedNameUsage: "Vitta virginea", records: 1, is_brackish: true },
      { scientificName: "Unio pictorum", records: 9, is_freshwater: true },
      { scientificName: "Tellina", records: 2, is_marine: true },
    ]);
    expect([...names].sort()).toEqual(["Mytilus edulis", "Neritina virginea", "Vitta virginea"]);
  });
});
