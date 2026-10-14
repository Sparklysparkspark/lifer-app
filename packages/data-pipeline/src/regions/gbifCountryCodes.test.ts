import { describe, expect, it } from "vitest";
import { countryCodeFilter, gbifDownloadFor } from "./gbifCountryCodes.js";

describe("gbifDownloadFor", () => {
  it("downloads an ordinary country by its own code", () => {
    expect(gbifDownloadFor("Australia", "AU")).toEqual({ codes: ["AU"], zipName: "AU" });
  });

  it("adds the codes of territories modelled as the parent's provinces", () => {
    expect(gbifDownloadFor("France", "FR").codes).toEqual(["FR", "GP", "GF", "MQ", "RE", "YT"]);
    // Svalbard and Bouvet Island are provinces of Norway; GBIF files them under SJ and BV.
    expect(gbifDownloadFor("Norway", "NO")).toEqual({ codes: ["NO", "SJ", "BV"], zipName: "NO" });
    expect(gbifDownloadFor("New Zealand", "NZ").codes).toEqual(["NZ", "TK"]);
  });

  it("downloads Christmas and Cocos Islands for Indian Ocean Ter., never Australia's file it shares an iso2 with", () => {
    // Ducula whartoni (Christmas Island Imperial-Pigeon): its records are coded CX, none AU.
    const ioa = gbifDownloadFor("Indian Ocean Ter.", "AU");
    expect(ioa.codes).toEqual(["CX", "CC"]);
    expect(ioa.zipName).not.toBe(gbifDownloadFor("Australia", "AU").zipName);
    expect(ioa.zipName).toMatch(/^[A-Z]{2}$/);
  });
});

describe("countryCodeFilter", () => {
  it("uses equality for one code and IN for several", () => {
    expect(countryCodeFilter(["AU"])).toBe("countrycode = 'AU'");
    expect(countryCodeFilter(["CX", "CC"])).toBe("countrycode IN ('CX', 'CC')");
  });
});
