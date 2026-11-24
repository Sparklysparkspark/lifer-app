import { describe, expect, it } from "vitest";
import { seaZonesRelevantFor } from "./useSeaZoneFilter";

const packs =
  (...taxa: string[]) =>
  (_id: string | null, taxonClass: string) =>
    taxa.includes(taxonClass);

describe("seaZonesRelevantFor", () => {
  it("offers nearby water for any sea class whose region pack is installed, not only fish", () => {
    expect(seaZonesRelevantFor(new Set(["nudibranchs"]), "r1", packs("nudibranchs"))).toBe(true);
    expect(seaZonesRelevantFor(new Set(["aves", "echinodermata"]), "r1", packs("echinodermata"))).toBe(true);
    expect(seaZonesRelevantFor(new Set(["actinopterygii"]), "r1", packs("actinopterygii"))).toBe(true);
  });

  it("hides it for land-only filters and before a filtered sea class's pack is installed", () => {
    expect(seaZonesRelevantFor(new Set(["aves", "amphibia"]), "r1", packs("aves", "amphibia"))).toBe(false);
    expect(seaZonesRelevantFor(new Set(["corals"]), "r1", packs("actinopterygii"))).toBe(false);
    expect(seaZonesRelevantFor(new Set(["other-taxa"]), "r1", packs("actinopterygii"))).toBe(false);
  });

  it("with no filter, needs any sea class pack; with no region, needs none", () => {
    expect(seaZonesRelevantFor(new Set(), "r1", packs("crustacea"))).toBe(true);
    expect(seaZonesRelevantFor(new Set(), "r1", packs("aves"))).toBe(false);
    expect(seaZonesRelevantFor(new Set(["testudines"]), null, packs())).toBe(true);
  });
});
