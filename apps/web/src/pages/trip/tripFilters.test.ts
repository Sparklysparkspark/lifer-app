import { describe, expect, it } from "vitest";
import type { PhotoFilters } from "../../lib/photoListFilters";
import type { TripPhoto } from "./types";
import { groupTripPhotos, tripTaxonFilters, visibleTripPhotos } from "./tripFilters";

const anyPhoto: PhotoFilters = {
  rawFiles: "show",
  editedRaw: "any",
  ratingMin: null,
  ratingMax: null,
  unrated: false,
  missingDate: false,
  dateFrom: "",
  dateTo: "",
};

function photo(partial: Partial<TripPhoto> & { photoId: string }): TripPhoto {
  return {
    width: null,
    height: null,
    captureId: `c-${partial.photoId}`,
    speciesId: "s",
    scientificName: "Alces alces",
    commonName: "Moose",
    takenAt: null,
    hasRaw: false,
    inatObservationId: null,
    originalRef: null,
    originalKind: null,
    originalManaged: null,
    tags: [],
    regionId: null,
    locationLabel: null,
    lat: null,
    lon: null,
    qualityRating: null,
    cameraModel: null,
    lens: null,
    focalLengthMm: null,
    aperture: null,
    shutter: null,
    iso: null,
    taxonClass: null,
    taxonOrder: null,
    family: null,
    sortOrder: null,
    tier: null,
    ...partial,
  };
}

const moose = photo({ photoId: "moose", takenAt: "2024-07-02T12:00:00Z" });
const chickadee = photo({
  photoId: "chickadee",
  scientificName: "Poecile atricapillus",
  commonName: "Black-capped Chickadee",
  takenAt: "2023-06-01T12:00:00Z",
  hasRaw: true,
  qualityRating: 5,
});
const unnamed = photo({ photoId: "unnamed", scientificName: "Lithobates sylvaticus", commonName: null });
const ids = (photos: TripPhoto[]) => photos.map((p) => p.photoId);

describe("visibleTripPhotos", () => {
  it("shows everything, in the server's order, with no search or filters", () => {
    expect(ids(visibleTripPhotos([moose, chickadee, unnamed], "", anyPhoto, "newest"))).toEqual([
      "moose",
      "chickadee",
      "unnamed",
    ]);
  });

  it("searches common and scientific names, ignoring case and surrounding spaces", () => {
    const photos = [moose, chickadee, unnamed];
    expect(ids(visibleTripPhotos(photos, "  CHICKADEE ", anyPhoto, "newest"))).toEqual(["chickadee"]);
    expect(ids(visibleTripPhotos(photos, "alces", anyPhoto, "newest"))).toEqual(["moose"]);
    expect(ids(visibleTripPhotos(photos, "sylvaticus", anyPhoto, "newest"))).toEqual(["unnamed"]);
  });

  it("applies the filters, judging RAW by the photo's own hasRaw", () => {
    const photos = [moose, chickadee];
    expect(ids(visibleTripPhotos(photos, "", { ...anyPhoto, editedRaw: "with" }, "newest"))).toEqual(["chickadee"]);
    expect(ids(visibleTripPhotos(photos, "", { ...anyPhoto, editedRaw: "without" }, "newest"))).toEqual(["moose"]);
    expect(ids(visibleTripPhotos(photos, "", { ...anyPhoto, ratingMin: 5 }, "newest"))).toEqual(["chickadee"]);
  });

  it("sorts what's left", () => {
    expect(ids(visibleTripPhotos([moose, chickadee], "", anyPhoto, "oldest"))).toEqual(["chickadee", "moose"]);
  });
});

describe("visibleTripPhotos species picker", () => {
  const jay = photo({
    photoId: "jay",
    speciesId: "jay-sp",
    commonName: "Blue Jay",
    scientificName: "Cyanocitta cristata",
  });

  it("keeps only the picked species, and every species when none is picked", () => {
    expect(ids(visibleTripPhotos([moose, jay], "", anyPhoto, "newest", new Set(["jay-sp"])))).toEqual(["jay"]);
    expect(ids(visibleTripPhotos([moose, jay], "", anyPhoto, "newest", new Set()))).toEqual(["moose", "jay"]);
  });
});

describe("groupTripPhotos", () => {
  // The page passes useSpeciesName(); the id stands in for it here.
  const name = (p: TripPhoto) => `name of ${p.speciesId}`;
  const moose2 = photo({ photoId: "moose2" });
  const jay = photo({ photoId: "jay", speciesId: "jay-sp", commonName: "Blue Jay", tier: "rare" });

  it("leaves an ungrouped list as it is", () => {
    const sorted = [moose, jay, moose2];
    expect(groupTripPhotos(sorted, "none", name)).toEqual({ photos: sorted, groups: null });
  });

  it("groups by species in sort order and reorders the photos to match the groups", () => {
    const { photos, groups } = groupTripPhotos([moose, jay, moose2], "species", name);
    expect(groups!.map((g) => g.label)).toEqual(["name of s", "name of jay-sp"]);
    expect(ids(photos)).toEqual(["moose", "moose2", "jay"]);
    // Each entry's index points at its own photo in the reordered list.
    for (const g of groups!) for (const e of g.entries) expect(photos[e.i]).toBe(e.item);
  });

  it("groups by rarity, rarest first", () => {
    const { groups } = groupTripPhotos([moose, jay], "tier", name);
    expect(groups!.map((g) => g.key)).toEqual(["rare", "common"]);
  });
});

describe("tripTaxonFilters", () => {
  it("lists each taxon class once, in the Collection's order, others after", () => {
    expect(
      tripTaxonFilters([
        { taxonClass: "insecta" },
        { taxonClass: "mammalia" },
        { taxonClass: "aves" },
        { taxonClass: "aves" },
        { taxonClass: null },
      ]),
    ).toEqual(["aves", "mammalia", "insecta"]);
  });
});
