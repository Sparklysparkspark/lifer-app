import { describe, expect, it } from "vitest";
import { observationPoint } from "./client.js";

describe("observationPoint", () => {
  it("reads iNaturalist's real response, where latitude and longitude are null", () => {
    expect(
      observationPoint({ location: "54.000849,-122.698819", geojson: { coordinates: [-122.698819, 54.000849] } }),
    ).toEqual({ lat: 54.000849, lon: -122.698819 });
  });

  it("prefers the owner's true point over an obscured one", () => {
    expect(observationPoint({ location: "54.0,-122.7", private_location: "54.0123,-122.6987" })).toEqual({
      lat: 54.0123,
      lon: -122.6987,
    });
  });

  it("falls back to the geojson point", () => {
    expect(observationPoint({ location: "", geojson: { coordinates: [-123.1, 49.2] } })).toEqual({
      lat: 49.2,
      lon: -123.1,
    });
  });

  it("is null when the observation has no location yet", () => {
    expect(observationPoint({ location: null, private_location: null, geojson: null })).toBeNull();
    expect(observationPoint({})).toBeNull();
  });
});
