// packages/shared/src/iucn.ts has no test runner of its own; the pipeline is its main writer.
import { describe, expect, it } from "vitest";
import {
  IUCN_CODES,
  IUCN_NAMES,
  iucnCodeFromInatLevel,
  iucnDisplayName,
  iucnSeverity,
  isIucnThreatened,
  mostSevereIucn,
  normalizeIucnStatus,
} from "@lifer/shared";

describe("normalizeIucnStatus", () => {
  it("maps every value found in the dev database", () => {
    const seen: Record<string, string> = {
      "least concern": "LC",
      "Data Deficient": "DD",
      endangered: "EN",
      vulnerable: "VU",
      "near threatened": "NT",
      "critically endangered": "CR",
      extinct: "EX",
      extinct_in_wild: "EW",
      "extinct in the wild": "EW",
      "not evaluated": "NE",
      "conservation dependent": "LR/cd",
    };
    for (const [raw, code] of Object.entries(seen)) expect(normalizeIucnStatus(raw), raw).toBe(code);
  });

  it("reads GBIF enums, iNaturalist names, codes in any case and Lower Risk subcategories", () => {
    expect(normalizeIucnStatus("LEAST_CONCERN")).toBe("LC");
    expect(normalizeIucnStatus("EXTINCT_IN_THE_WILD")).toBe("EW");
    expect(normalizeIucnStatus("Critically Endangered")).toBe("CR");
    expect(normalizeIucnStatus("Critically Endangered (Possibly Extinct)")).toBe("CR");
    expect(normalizeIucnStatus("vu")).toBe("VU");
    expect(normalizeIucnStatus(" Near-Threatened ")).toBe("NT");
    expect(normalizeIucnStatus("LR/lc")).toBe("LC");
    expect(normalizeIucnStatus("LR/nt")).toBe("NT");
    expect(normalizeIucnStatus("lr/cd")).toBe("LR/cd");
    expect(normalizeIucnStatus("Lower Risk/conservation dependent")).toBe("LR/cd");
  });

  it("passes codes through and refuses what isn't a global Red List category", () => {
    for (const c of IUCN_CODES) expect(normalizeIucnStatus(c)).toBe(c);
    for (const junk of [
      null,
      undefined,
      "",
      "Regionally Extinct",
      "Not Applicable",
      "lower risk",
      "S3",
      "G4",
      "domesticated",
    ]) {
      expect(normalizeIucnStatus(junk), String(junk)).toBeNull();
    }
  });

  it("has a display name for every code", () => {
    for (const c of IUCN_CODES) expect(iucnDisplayName(c)).toBe(IUCN_NAMES[c]);
    expect(iucnDisplayName("least concern")).toBe("Least Concern");
    expect(iucnDisplayName(null)).toBeNull();
  });
});

describe("severity", () => {
  it("orders the codes from extinct down to not evaluated", () => {
    const ordered = [...IUCN_CODES].sort((a, b) => iucnSeverity(b) - iucnSeverity(a));
    expect(ordered).toEqual(["EX", "EW", "CR", "EN", "VU", "LR/cd", "NT", "LC", "DD", "NE"]);
    expect(iucnSeverity(null)).toBe(0);
    expect(iucnSeverity("NE")).toBeGreaterThan(0);
  });

  it("picks the most severe of several", () => {
    expect(mostSevereIucn(["LC", "VU", "NT"])).toBe("VU");
    expect(mostSevereIucn(["DD", "LC"])).toBe("LC");
    expect(mostSevereIucn([null, undefined])).toBeNull();
  });

  it("calls only CR, EN and VU threatened", () => {
    expect(IUCN_CODES.filter(isIucnThreatened)).toEqual(["CR", "EN", "VU"]);
  });
});

describe("iucnCodeFromInatLevel", () => {
  it("maps iNaturalist's numeric levels", () => {
    expect(iucnCodeFromInatLevel(0)).toBe("NE");
    expect(iucnCodeFromInatLevel(10)).toBe("LC");
    expect(iucnCodeFromInatLevel(50)).toBe("CR");
    expect(iucnCodeFromInatLevel(70)).toBe("EX");
    expect(iucnCodeFromInatLevel(15)).toBeNull();
    expect(iucnCodeFromInatLevel(null)).toBeNull();
  });
});
