import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { INaturalistTaxonRecord } from "./lazyEnrich.js";

// Photo downloads answer 404 (not retried), so no files are cached; the choice of photos is
// what's under test.
beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 })),
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const { enrichmentFromTaxonRecord } = await import("./lazyEnrich.js");

const photo = (id: number, license: string | null) => ({
  medium_url: `https://inaturalist-open-data.s3.amazonaws.com/photos/${id}/medium.jpg`,
  license_code: license,
  attribution: `Photographer ${id}`,
});

function taxon(defaultLicense: string | null, galleryLicenses: Array<string | null>): INaturalistTaxonRecord {
  return {
    id: 1,
    name: "Testus photographicus",
    default_photo: photo(1, defaultLicense),
    taxon_photos: [
      { photo: photo(1, defaultLicense) },
      ...galleryLicenses.map((l, i) => ({ photo: photo(10 + i, l) })),
    ],
  };
}

describe("enrichmentFromTaxonRecord", () => {
  it("uses the default photo and every gallery photo for personal viewing, whatever the license", async () => {
    const result = await enrichmentFromTaxonRecord("s1", taxon(null, ["cc-by", null]));

    expect(result.referencePhoto).toContain("/photos/1/");
    expect(result.referenceLicense).toBe("all-rights-reserved");
    expect(result.gallery.map((g) => g.license)).toEqual(["cc-by", "all-rights-reserved"]);
  });

  it("with publishableOnly, replaces an unpublishable default photo with the first publishable one", async () => {
    const result = await enrichmentFromTaxonRecord("s2", taxon(null, [null, "cc-by-nc", "cc0"]), {
      publishableOnly: true,
    });

    expect(result.referencePhoto).toContain("/photos/11/");
    expect(result.referenceLicense).toBe("cc-by-nc");
    expect(result.referenceCredit).toBe("Photographer 11");
    // The promoted photo leaves the gallery; the all-rights-reserved one was never taken.
    expect(result.gallery.map((g) => g.license)).toEqual(["cc0"]);
  });

  it("with publishableOnly, keeps a publishable default photo", async () => {
    const result = await enrichmentFromTaxonRecord("s3", taxon("cc-by-sa", ["cc-by"]), { publishableOnly: true });

    expect(result.referencePhoto).toContain("/photos/1/");
    expect(result.gallery.map((g) => g.license)).toEqual(["cc-by"]);
  });

  it("with publishableOnly, leaves a species with nothing publishable photoless and reports its photo withheld", async () => {
    const result = await enrichmentFromTaxonRecord("s4", taxon(null, [null, null]), { publishableOnly: true });

    expect(result.referencePhoto).toBeNull();
    expect(result.gallery).toEqual([]);
    expect(result.photoWithheld).toBe(true);
  });

  it("with publishableOnly, reports a withheld photo when only the default photo exists and can't be published", async () => {
    const result = await enrichmentFromTaxonRecord(
      "s5",
      { ...taxon("gfdl", []), taxon_photos: [] },
      { publishableOnly: true },
    );

    expect(result.referencePhoto).toBeNull();
    expect(result.photoWithheld).toBe(true);
  });

  it("with publishableOnly, reports a withheld gallery photo even without a default photo", async () => {
    const record = { ...taxon(null, ["copyright"]), default_photo: null, taxon_photos: [{ photo: photo(20, null) }] };
    const result = await enrichmentFromTaxonRecord("s6", record, { publishableOnly: true });

    expect(result.referencePhoto).toBeNull();
    expect(result.photoWithheld).toBe(true);
  });

  it("with publishableOnly, reports nothing withheld when a publishable photo was found", async () => {
    const result = await enrichmentFromTaxonRecord("s7", taxon(null, ["cc-by"]), { publishableOnly: true });

    expect(result.referenceLicense).toBe("cc-by");
    expect(result.photoWithheld).toBe(false);
  });

  it("with publishableOnly, reports nothing withheld when iNaturalist has no photo at all", async () => {
    const record: INaturalistTaxonRecord = { id: 2, name: "Testus invisibilis", default_photo: null, taxon_photos: [] };
    const result = await enrichmentFromTaxonRecord("s8", record, { publishableOnly: true });

    expect(result.referencePhoto).toBeNull();
    expect(result.photoWithheld).toBe(false);
  });

  it("leaves the withheld flag unset for personal viewing", async () => {
    const result = await enrichmentFromTaxonRecord("s9", taxon(null, [null]));

    expect(result.photoWithheld).toBeUndefined();
  });
});

describe("description from a taxon record", () => {
  const summary =
    "The <b>common garter snake</b> (<i>Thamnophis sirtalis</i>) is a species of natricine snake, which is indigenous to North America and found widely across the continent. Most common garter snakes have a pattern of yellow stripes on a black, brown or green background. The average body mass is 150&nbsp;g (5.3&nbsp;oz). Common garter snakes are the state reptile of...";

  it("applies the shared rule, encodes the URL and records that text was checked", async () => {
    const result = await enrichmentFromTaxonRecord("s1", {
      id: 28362,
      name: "Thamnophis sirtalis",
      wikipedia_summary: summary,
      wikipedia_url: "https://en.wikipedia.org/wiki/Thamnophis sirtalis",
    });
    expect(result.description).toBe(
      "Most common garter snakes have a pattern of yellow stripes on a black, brown or green background. The average body mass is 150 g (5.3 oz).",
    );
    expect(result.descriptionSourceUrl).toBe("https://en.wikipedia.org/wiki/Thamnophis_sirtalis");
    expect(result.descriptionCredit).toBe("Wikipedia contributors (CC BY-SA), via iNaturalist");
    expect(result.descriptionChecked).toBe(true);
  });

  it("a record without a summary is still a checked answer", async () => {
    const result = await enrichmentFromTaxonRecord("s1", { id: 1, name: "Testus nullus" });
    expect(result.description).toBeNull();
    expect(result.descriptionChecked).toBe(true);
  });

  it("a summary without a URL counts as none (description_requires_credit)", async () => {
    const { descriptionFromINaturalistSummary } = await import("./lazyEnrich.js");
    expect(descriptionFromINaturalistSummary(summary, null)).toBeNull();
  });
});

describe("enrichSpecies when the taxon record can't be read", () => {
  it("keeps the photo from the search but doesn't count the text as checked", async () => {
    const { enrichSpecies } = await import("./lazyEnrich.js");
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/v1/taxa?q=")) {
        return new Response(
          JSON.stringify({ results: [{ id: 28362, name: "Thamnophis sirtalis", default_photo: photo(5, "cc-by") }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/taxa/28362")) return new Response("busy", { status: 500 });
      return new Response(null, { status: 404 });
    });
    const result = await enrichSpecies({ id: "s2", scientific_name: "Thamnophis sirtalis" });
    expect(result.referencePhoto).toBe(photo(5, "cc-by").medium_url);
    expect(result.description).toBeNull();
    expect(result.descriptionChecked).toBe(false);
  });
});
