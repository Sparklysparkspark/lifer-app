import { describe, expect, it } from "vitest";
import { planPhotoLicenseFixes, type GalleryPhoto } from "./photoLicensePolicy.js";

const photo = (id: string, speciesId: string, license: string | null, sortOrder: number): GalleryPhoto => ({
  id,
  speciesId,
  license,
  sortOrder,
});

describe("planPhotoLicenseFixes", () => {
  it("leaves publishable photos alone", () => {
    const plan = planPhotoLicenseFixes([{ speciesId: "a", license: "cc-by" }], [photo("g1", "a", "cc0", 0)]);
    expect(plan).toEqual({ deleteGalleryIds: [], promote: [], clear: [] });
  });

  it("removes gallery photos that can't be published, including ones with no license", () => {
    const plan = planPhotoLicenseFixes(
      [],
      [
        photo("g1", "a", "gfdl", 0),
        photo("g2", "a", null, 1),
        photo("g3", "a", "all-rights-reserved", 2),
        photo("g4", "a", "cc-by-sa", 3),
      ],
    );
    expect(plan.deleteGalleryIds.sort()).toEqual(["g1", "g2", "g3"]);
  });

  it("replaces an unpublishable main photo with the first publishable gallery photo by sort order", () => {
    const plan = planPhotoLicenseFixes(
      [{ speciesId: "a", license: "all-rights-reserved" }],
      [photo("g-late", "a", "cc-by", 5), photo("g-nc", "a", "all-rights-reserved", 0), photo("g-early", "a", "cc0", 1)],
    );
    expect(plan.promote).toEqual([{ speciesId: "a", galleryId: "g-early" }]);
    // The promoted photo leaves the gallery, so it isn't shown twice.
    expect(plan.deleteGalleryIds.sort()).toEqual(["g-early", "g-nc"]);
    expect(plan.clear).toEqual([]);
  });

  it("never promotes another species' photo", () => {
    const plan = planPhotoLicenseFixes([{ speciesId: "a", license: null }], [photo("g1", "b", "cc-by", 0)]);
    expect(plan.promote).toEqual([]);
    expect(plan.clear).toEqual(["a"]);
  });

  it("clears a main photo when the species has nothing publishable", () => {
    const plan = planPhotoLicenseFixes(
      [{ speciesId: "a", license: "gfdl" }],
      [photo("g1", "a", "all-rights-reserved", 0)],
    );
    expect(plan.clear).toEqual(["a"]);
    expect(plan.promote).toEqual([]);
    expect(plan.deleteGalleryIds).toEqual(["g1"]);
  });
});
