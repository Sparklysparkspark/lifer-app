// What an observation sends: only what the photos recorded, never a guessed date or location.
import { describe, expect, it } from "vitest";
import { observationFields } from "./client.js";

describe("observationFields", () => {
  it("sends the camera's date and GPS when there are some", () => {
    expect(
      observationFields({
        taxonId: 4956,
        observedOn: "2026-09-13T08:15:00Z",
        location: { lat: 49.1, lon: -123.2 },
        placeGuess: "British Columbia, Canada",
      }),
    ).toEqual({
      taxon_id: 4956,
      observed_on_string: "2026-09-13T08:15:00Z",
      latitude: 49.1,
      longitude: -123.2,
      place_guess: "British Columbia, Canada",
    });
  });

  it("leaves out a date and coordinates the photos don't have, rather than filling them in", () => {
    const fields = observationFields({
      taxonId: 4956,
      observedOn: null,
      location: null,
      placeGuess: "Ontario, Canada",
    });
    expect(fields).toEqual({ taxon_id: 4956, place_guess: "Ontario, Canada" });
    expect(fields).not.toHaveProperty("latitude");
    expect(fields).not.toHaveProperty("positional_accuracy");
    expect(fields).not.toHaveProperty("observed_on_string");
  });

  it("sends no place text when the photos have no region", () => {
    expect(observationFields({ taxonId: 1, observedOn: null, location: null, placeGuess: null })).toEqual({
      taxon_id: 1,
    });
  });
});
