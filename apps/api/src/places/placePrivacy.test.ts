import { describe, expect, it } from "vitest";
import { distanceM, sendPlaceFields, strictest, type PhotoForPrivacy, type PlaceForPrivacy } from "./placePrivacy.js";
import { farPhotos, spotEdit } from "./savedSpots.js";

const pond: PlaceForPrivacy = {
  name: "King Fisher Pond",
  lat: 53.9,
  lon: -122.75,
  radius_m: 100,
  geoprivacy: "obscured",
  locality: "Prince George, British Columbia, Canada",
};
const photo = (over: Partial<PhotoForPrivacy> = {}): PhotoForPrivacy => ({
  id: "p1",
  lat: null,
  lon: null,
  location_label: null,
  location_source: null,
  location_accuracy_m: null,
  ...over,
});
const send = (places: PlaceForPrivacy[], photos: PhotoForPrivacy[]) =>
  sendPlaceFields({
    places,
    photos,
    sent: photos.find((p) => p.lat !== null) ?? null,
    placeGuess: photos[0]?.location_label ? `${photos[0].location_label}, British Columbia, Canada` : null,
    regionName: "British Columbia, Canada",
  });

describe("sendPlaceFields", () => {
  it("keeps a renamed place's photos obscured: their point is still inside it", () => {
    // The spot was renamed; the photo still carries the old label, so no label matches.
    const renamed = { ...pond, name: "Kingfisher Pond (north)" };
    const fields = send([renamed], [photo({ lat: 53.9003, lon: -122.7502, location_label: "King Fisher Pond" })]);
    expect(fields.geoprivacy).toBe("obscured");
    // The user's own name for the spot never goes out for a hidden place.
    expect(fields.placeGuess).toBe("Prince George, British Columbia, Canada");
  });

  it("matches by label too, for photos with no point", () => {
    expect(send([pond], [photo({ location_label: "king fisher pond" })]).geoprivacy).toBe("obscured");
  });

  it("takes the stricter of two places containing the photo", () => {
    const park = { ...pond, name: "Cottonwood Park", radius_m: 2000, geoprivacy: "private" as const };
    expect(send([pond, park], [photo({ lat: 53.9, lon: -122.75 })]).geoprivacy).toBe("private");
  });

  it("leaves geoprivacy out with no place (iNaturalist hides threatened species itself)", () => {
    const far = photo({ lat: 10, lon: 10, location_label: "Somewhere" });
    expect(send([pond], [far]).geoprivacy).toBeNull();
    expect(send([pond], [far]).placeGuess).toBe("Somewhere, British Columbia, Canada");
  });

  it("sends an open place's name and the radius as accuracy for a point it gave", () => {
    const open = { ...pond, geoprivacy: "open" as const };
    const fields = send(
      [open],
      [
        photo({
          lat: 53.9,
          lon: -122.75,
          location_label: "King Fisher Pond",
          location_source: "spot",
          location_accuracy_m: 100,
        }),
      ],
    );
    expect(fields).toEqual({
      geoprivacy: "open",
      positionalAccuracy: 100,
      placeGuess: "King Fisher Pond, British Columbia, Canada",
    });
  });

  it("sends no accuracy for camera GPS, but the radius for an older placing at the centre", () => {
    const open = { ...pond, geoprivacy: "open" as const };
    expect(send([open], [photo({ lat: 53.9004, lon: -122.75 })]).positionalAccuracy).toBeNull();
    expect(send([open], [photo({ lat: 53.9, lon: -122.75 })]).positionalAccuracy).toBe(100);
  });
});

describe("helpers", () => {
  it("strictest", () => {
    expect(strictest([])).toBe("open");
    expect(strictest(["open", "private", "obscured"])).toBe("private");
  });
  it("distanceM", () => {
    expect(Math.round(distanceM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) / 1000)).toBe(111);
  });
  it("farPhotos skips points a spot gave and those near it", () => {
    const spot = { lat: 53.9, lon: -122.75, radius_m: 100 };
    const far = farPhotos(spot, [
      { lat: 53.9, lon: -122.76, location_source: null }, // about 650 m: near enough
      { lat: 54.26, lon: -122.75, location_source: null }, // about 40 km
      { lat: 49, lon: -123, location_source: "spot" }, // a re-file, not GPS
      { lat: null, lon: null, location_source: null },
    ]);
    expect(far).toEqual({ count: 1, km: 40 });
  });
  it("spotEdit keeps own points unless told to move them", () => {
    const spot = { name: "Pond", lat: 1, lon: 2, region_id: null, radius_m: 250 };
    expect(spotEdit(spot)).toMatchObject({ source: "spot", accuracyM: 250, keep: "own", label: "Pond" });
    expect(spotEdit(spot, true).keep).toBeUndefined();
  });
});
