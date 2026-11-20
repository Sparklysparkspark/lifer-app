import { describe, expect, it } from "vitest";
import { exoticRegionCode, matchEbirdCode } from "./fix-ebird-region-codes.js";

const spain = [
  { code: "ES-CM", name: "Castilla-La Mancha" },
  { code: "ES-CM-AB", name: "Albacete" },
  { code: "ES-MD", name: "Madrid, Comunidad de" },
  { code: "ES-MD-MD", name: "Madrid" },
  { code: "ES-GA-AC", name: "A Coruña" },
];

describe("matchEbirdCode", () => {
  it("keeps a code eBird knows", () => {
    expect(matchEbirdCode({ code: "ES-CM", name: "Castilla-La Mancha" }, spain)).toBe("ES-CM");
  });

  it("finds the eBird code ending the same way", () => {
    expect(matchEbirdCode({ code: "ES-AB", name: "Albacete" }, spain)).toBe("ES-CM-AB");
  });

  it("falls back to the name, ignoring accents, commas and admin words", () => {
    expect(matchEbirdCode({ code: "CN-BJ", name: "Beijing" }, [{ code: "CN-11", name: "Beijing" }])).toBe("CN-11");
    expect(matchEbirdCode({ code: "BD-C", name: "Dhaka" }, [{ code: "BD-3", name: "Dhaka bibhag" }])).toBe("BD-3");
    expect(matchEbirdCode({ code: "VN-SG", name: "Hồ Chí Minh" }, [{ code: "VN-79", name: "Ho Chi Minh" }])).toBe(
      "VN-79",
    );
  });

  it("takes the province over a one-province community of the same name", () => {
    expect(matchEbirdCode({ code: "ES-M", name: "Madrid" }, spain)).toBe("ES-MD-MD");
  });

  it("leaves a province eBird has no single region for", () => {
    expect(matchEbirdCode({ code: "ES-C", name: "La Coruña" }, spain)).toBeNull();
    expect(matchEbirdCode({ code: "DK-84", name: "Hovedstaden" }, [{ code: "DK-01", name: "København" }])).toBeNull();
  });
});

describe("exoticRegionCode", () => {
  const italy = [
    { code: "IT-62", name: "Lazio" },
    { code: "IT-65", name: "Abruzzo" },
  ];

  it("uses the province's own code when eBird knows it", () => {
    expect(exoticRegionCode("IT-62", null, italy)).toBe("IT-62");
  });

  it("borrows the eBird region named like the province's group, else the country", () => {
    expect(exoticRegionCode("IT-RM", "Lazio", italy)).toBe("IT-62");
    expect(exoticRegionCode("GB-CMD", "England - London", [{ code: "GB-ENG", name: "England" }])).toBe("GB");
  });

  it("has nothing to borrow for a placeholder outside any country", () => {
    expect(exoticRegionCode("-99-X02~", null, [])).toBeNull();
  });
});
