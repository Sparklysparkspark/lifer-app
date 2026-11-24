import { describe, expect, it } from "vitest";
import { decideIsVagrant, iconicOfClass, inatVagrancy, vagrantWindowYears } from "./inatVagrancy.js";

// A place well observed for birds, as Canada is (3.3 million research-grade bird observations).
const birds = { iconic: "Aves", groupObs: 3_300_000 };

describe("inatVagrancy", () => {
  it("calls a chased stray a vagrant: many observations, one year", () => {
    expect(inatVagrancy({ ...birds, observations: 46, yearsPresent: 1 })).toBe("vagrant");
  });

  it("calls a scarce bird seen most years regular", () => {
    expect(inatVagrancy({ ...birds, observations: 47, yearsPresent: 9 })).toBe("resident");
    expect(inatVagrancy({ ...birds, observations: 5, yearsPresent: 3 })).toBe("resident");
  });

  it("calls a bird with old records only a vagrant", () => {
    expect(inatVagrancy({ ...birds, observations: 3, yearsPresent: 0 })).toBe("vagrant");
  });

  it("is unsure where birds are little observed, or the years weren't fetched", () => {
    expect(inatVagrancy({ ...birds, groupObs: 5000, observations: 2, yearsPresent: 1 })).toBe("unsure");
    expect(inatVagrancy({ ...birds, observations: 46, yearsPresent: null })).toBe("unsure");
  });

  it("leaves groups other than birds to GBIF, however well observed", () => {
    expect(inatVagrancy({ iconic: "Actinopterygii", groupObs: 500_000, observations: 1, yearsPresent: 1 })).toBe(
      "unsure",
    );
  });

  it("needs no years for a well-observed species", () => {
    expect(inatVagrancy({ iconic: "Aves", groupObs: 0, observations: 5000, yearsPresent: null })).toBe("resident");
  });
});

describe("decideIsVagrant", () => {
  const base = { current: false, override: null, introduced: false, domestic: false } as const;

  it("lets iNaturalist overrule GBIF either way", () => {
    expect(decideIsVagrant({ ...base, inat: "vagrant", current: false })).toBe(true);
    expect(decideIsVagrant({ ...base, inat: "resident", current: true })).toBe(false);
  });

  it("falls back to GBIF's flag only when iNaturalist is unsure", () => {
    expect(decideIsVagrant({ ...base, inat: "unsure", current: true })).toBe(true);
    expect(decideIsVagrant({ ...base, inat: "unsure", current: false })).toBe(false);
  });

  it("keeps a hand-checked override, introduced listings' flags and farm animals unflagged", () => {
    expect(decideIsVagrant({ ...base, inat: "vagrant", override: false })).toBe(false);
    expect(decideIsVagrant({ ...base, inat: "vagrant", introduced: true, current: false })).toBe(false);
    expect(decideIsVagrant({ ...base, inat: "vagrant", domestic: true })).toBe(false);
  });
});

describe("vagrantWindowYears", () => {
  it("is the ten complete years before this one", () => {
    expect(vagrantWindowYears(new Date("2026-11-23"))).toEqual([
      2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025,
    ]);
  });
});

describe("iconicOfClass", () => {
  it("maps catalog classes to iNaturalist's groups, the rest to Animalia", () => {
    expect(iconicOfClass("squamata")).toBe("Reptilia");
    expect(iconicOfClass("nudibranchs")).toBe("Mollusca");
    expect(iconicOfClass("corals")).toBe("Animalia");
  });
});
