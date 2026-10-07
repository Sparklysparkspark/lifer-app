import { afterEach, describe, expect, it } from "vitest";
import { isLicenseAllowed, isPublishableLicense, isRestrictedLicense, normalizeLicense } from "./licensePolicy.js";

describe("normalizeLicense", () => {
  it("strips a version suffix", () => {
    expect(normalizeLicense("cc-by-sa-3.0")).toBe("cc-by-sa");
    expect(normalizeLicense("cc-by-4.0")).toBe("cc-by");
  });

  it("lowercases the code", () => {
    expect(normalizeLicense("CC-BY-SA-3.0")).toBe("cc-by-sa");
  });

  it("leaves a code with no version suffix unchanged", () => {
    expect(normalizeLicense("cc0")).toBe("cc0");
  });

  it("strips a version of any shape: no dot, several parts, several digits", () => {
    expect(normalizeLicense("cc-by-4")).toBe("cc-by");
    expect(normalizeLicense("cc-by-nc-2.5.1")).toBe("cc-by-nc");
    expect(normalizeLicense("cc-by-sa-10.12")).toBe("cc-by-sa");
  });

  it("strips only a trailing version, so a ported license isn't mistaken for the generic one", () => {
    expect(normalizeLicense("cc-by-sa-3.0-de")).toBe("cc-by-sa-3.0-de");
  });
});

describe("isRestrictedLicense", () => {
  it("flags NC/ND variants as restricted", () => {
    expect(isRestrictedLicense("cc-by-nc")).toBe(true);
    expect(isRestrictedLicense("cc-by-nc-sa-2.0")).toBe(true);
    expect(isRestrictedLicense("cc-by-nd")).toBe(true);
    expect(isRestrictedLicense("cc-by-nc-nd")).toBe(true);
  });

  it("does not flag commercial-safe licenses", () => {
    expect(isRestrictedLicense("cc0")).toBe(false);
    expect(isRestrictedLicense("cc-by")).toBe(false);
    expect(isRestrictedLicense("cc-by-sa")).toBe(false);
  });
});

describe("isLicenseAllowed", () => {
  const ORIGINAL_ENV = process.env.LIFER_ALLOW_NONCOMMERCIAL_PHOTOS;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.LIFER_ALLOW_NONCOMMERCIAL_PHOTOS;
    else process.env.LIFER_ALLOW_NONCOMMERCIAL_PHOTOS = ORIGINAL_ENV;
  });

  it("always allows commercial-safe licenses", () => {
    delete process.env.LIFER_ALLOW_NONCOMMERCIAL_PHOTOS;
    expect(isLicenseAllowed("cc0")).toBe(true);
    expect(isLicenseAllowed("cc-by")).toBe(true);
    expect(isLicenseAllowed("cc-by-sa-4.0")).toBe(true);
  });

  it("rejects restricted licenses by default", () => {
    delete process.env.LIFER_ALLOW_NONCOMMERCIAL_PHOTOS;
    expect(isLicenseAllowed("cc-by-nc")).toBe(false);
  });

  it("rejects an unrecognized license code", () => {
    delete process.env.LIFER_ALLOW_NONCOMMERCIAL_PHOTOS;
    expect(isLicenseAllowed("all-rights-reserved")).toBe(false);
  });

  it("allows restricted licenses only when the env override is set", () => {
    process.env.LIFER_ALLOW_NONCOMMERCIAL_PHOTOS = "1";
    expect(isLicenseAllowed("cc-by-nc-sa")).toBe(true);
    expect(isLicenseAllowed("cc-by-nd-2.0")).toBe(true);
  });

  it("still rejects an unrecognized code even with the override set", () => {
    process.env.LIFER_ALLOW_NONCOMMERCIAL_PHOTOS = "1";
    expect(isLicenseAllowed("all-rights-reserved")).toBe(false);
  });
});

describe("isPublishableLicense", () => {
  afterEach(() => {
    delete process.env.LIFER_ALLOW_NONCOMMERCIAL_PHOTOS;
  });

  it("allows every Creative Commons license and public domain, with or without a version", () => {
    for (const code of [
      "cc0",
      "pd",
      "cc-by",
      "cc-by-sa",
      "cc-by-nd",
      "cc-by-nc",
      "cc-by-nc-sa",
      "cc-by-nc-nd",
      "CC-BY-4.0",
      "cc-by-nc-4.0",
    ]) {
      expect(isPublishableLicense(code)).toBe(true);
    }
  });

  it("rejects all-rights-reserved, GFDL, unknown and missing licenses", () => {
    for (const code of ["all-rights-reserved", "gfdl", "copyright", null, undefined]) {
      expect(isPublishableLicense(code)).toBe(false);
    }
  });

  it("ignores the local-development override", () => {
    process.env.LIFER_ALLOW_NONCOMMERCIAL_PHOTOS = "1";
    expect(isPublishableLicense("all-rights-reserved")).toBe(false);
  });
});
