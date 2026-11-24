// What an observation sends: only what the photos recorded, never a guessed date or location.
import { describe, expect, it, vi } from "vitest";
import { InatHttpError, observationFields, updateObservationLocation } from "./client.js";

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

  it("sends a saved spot's geoprivacy only when there is one", () => {
    const draft = { taxonId: 1, observedOn: null, location: { lat: 1, lon: 2 }, placeGuess: null };
    expect(observationFields({ ...draft, geoprivacy: "obscured" })).toMatchObject({ geoprivacy: "obscured" });
    expect(observationFields(draft)).not.toHaveProperty("geoprivacy");
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

describe("updateObservationLocation", () => {
  const ok = () => new Response("{}", { status: 200 });
  const update = { lat: 49.3, lon: -123.2, positionalAccuracy: 500, geoprivacy: "obscured" };

  it("PUTs the point, accuracy and privacy, keeping the observation's photos", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok());
    await updateObservationLocation("jwt", "7001", update, { fetchImpl, sleep: async () => {} });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.inaturalist.org/v1/observations/7001");
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({ Authorization: "jwt", "Content-Type": "application/json" });
    expect((init?.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
    expect(JSON.parse(String(init?.body))).toEqual({
      ignore_photos: true,
      observation: { latitude: 49.3, longitude: -123.2, positional_accuracy: 500, geoprivacy: "obscured" },
    });
  });

  it("leaves out an accuracy and privacy it doesn't have", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok());
    await updateObservationLocation(
      "jwt",
      "7001",
      { lat: 1, lon: 2, positionalAccuracy: null, geoprivacy: null },
      {
        fetchImpl,
      },
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).observation).toEqual({ latitude: 1, longitude: 2 });
  });

  it("waits out a rate limit, honouring Retry-After", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "3" } }))
      .mockResolvedValueOnce(ok());
    const sleep = vi.fn(async (_ms: number) => {});
    await updateObservationLocation("jwt", "7001", update, { fetchImpl, sleep });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("throws a 401 at once, for the caller to ask for a reconnect", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 401 }));
    const err = await updateObservationLocation("jwt", "7001", update, { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InatHttpError);
    expect((err as InatHttpError).status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses an id that isn't a number", async () => {
    await expect(updateObservationLocation("jwt", "../users", update, { fetchImpl: vi.fn() })).rejects.toThrow();
  });
});
