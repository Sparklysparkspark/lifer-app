import { describe, expect, it } from "vitest";
import type { PhotoFilters } from "../../lib/photoListFilters";
import type { TripPhoto } from "./types";
import { visibleTripPhotos, visibleTripSpecies } from "./tripFilters";

const anyPhoto: PhotoFilters = { rawFilter: "any", onlyTopRated: false, dateFrom: "", dateTo: "" };

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
    originalRef: null,
    originalKind: null,
    qualityRating: null,
    cameraModel: null,
    lens: null,
    focalLengthMm: null,
    aperture: null,
    shutter: null,
    iso: null,
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
    expect(ids(visibleTripPhotos(photos, "", { ...anyPhoto, rawFilter: "with" }, "newest"))).toEqual(["chickadee"]);
    expect(ids(visibleTripPhotos(photos, "", { ...anyPhoto, rawFilter: "without" }, "newest"))).toEqual(["moose"]);
    expect(ids(visibleTripPhotos(photos, "", { ...anyPhoto, onlyTopRated: true }, "newest"))).toEqual(["chickadee"]);
  });

  it("sorts what's left", () => {
    expect(ids(visibleTripPhotos([moose, chickadee], "", anyPhoto, "oldest"))).toEqual(["chickadee", "moose"]);
  });
});

describe("visibleTripSpecies", () => {
  const species = [
    { commonName: "Moose", scientificName: "Alces alces" },
    { commonName: null, scientificName: "Lithobates sylvaticus" },
  ];

  it("returns the same list for a blank search", () => {
    expect(visibleTripSpecies(species, "   ")).toBe(species);
  });

  it("matches either name", () => {
    expect(visibleTripSpecies(species, "moo")).toEqual([species[0]]);
    expect(visibleTripSpecies(species, "Lithobates")).toEqual([species[1]]);
    expect(visibleTripSpecies(species, "owl")).toEqual([]);
  });
});
