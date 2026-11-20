import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dedupePlaces,
  OnlinePlacesUnavailable,
  resetOnlinePlaces,
  reversePlaceName,
  searchPlaces,
} from "./onlinePlaces";

const feature = (name: string, lon: number, lat: number, props: object = {}) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { osm_type: "R", osm_id: Math.round(lat * 1000), name, ...props },
});
const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body });
const sentUrl = (i = 0) => new URL(fetchMock.mock.calls[i][0] as string);

beforeEach(() => {
  resetOnlinePlaces();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("searchPlaces", () => {
  it("sends only the text and the map centre rounded to one decimal", async () => {
    reply({
      features: [
        feature("Point Pelee National Park", -82.513, 41.945, {
          osm_value: "national_park",
          city: "Leamington",
          state: "Ontario",
          country: "Canada",
          extent: [-82.69, 41.99, -82.5, 41.68],
        }),
      ],
    });
    const [place] = await searchPlaces("point pelee", { bias: { lat: 41.9451, lon: -82.5131 } });
    const url = sentUrl();
    expect(url.host).toBe("photon.komoot.io");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "point pelee",
      limit: "6",
      lang: "en",
      lat: "41.9",
      lon: "-82.5",
    });
    expect(place).toMatchObject({
      kind: "online",
      placeKind: "park",
      region: "Leamington, Ontario, Canada",
      bbox: [-82.69, 41.68, -82.5, 41.99],
    });
  });

  it("asks nothing under three characters, and never twice for one query", async () => {
    expect(await searchPlaces("po")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    reply({ features: [feature("Tofino", -125.9, 49.15)] });
    await searchPlaces("tofino");
    await searchPlaces("tofino");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops repeats of the same place", async () => {
    reply({ features: [feature("Point Pelee", -82.51, 41.94), feature("Point Pelee", -82.52, 41.95)] });
    expect(await searchPlaces("point pelee")).toHaveLength(1);
  });

  it("backs off after a 429 instead of retrying at typing speed", async () => {
    reply({}, 429);
    await expect(searchPlaces("tofino")).rejects.toBeInstanceOf(OnlinePlacesUnavailable);
    await expect(searchPlaces("tofino b")).rejects.toBeInstanceOf(OnlinePlacesUnavailable);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a network failure as unavailable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(searchPlaces("tofino")).rejects.toBeInstanceOf(OnlinePlacesUnavailable);
  });
});

describe("reversePlaceName", () => {
  it("sends the point rounded to about 100 m and names town, province and country", async () => {
    reply({
      features: [
        {
          geometry: { coordinates: [0, 0] },
          properties: { city: "Prince George", state: "British Columbia", country: "Canada" },
        },
      ],
    });
    expect(await reversePlaceName(53.917234, -122.749876)).toBe("Prince George, British Columbia, Canada");
    expect(sentUrl().pathname).toBe("/reverse");
    expect(sentUrl().searchParams.get("lat")).toBe("53.917");
    expect(sentUrl().searchParams.get("lon")).toBe("-122.75");
  });

  it("returns null when nothing is there", async () => {
    reply({ features: [] });
    expect(await reversePlaceName(0, 0)).toBeNull();
  });
});

describe("dedupePlaces", () => {
  it("keeps the library's place first and drops the online one of the same name nearby", () => {
    const local = [{ name: "Tofino", lat: 49.15, lon: -125.9 }];
    const online = [
      { name: "tofino", lat: 49.16, lon: -125.91 },
      { name: "Tofino", lat: 10, lon: 10 },
    ];
    expect(dedupePlaces(online, local)).toEqual([{ name: "Tofino", lat: 10, lon: 10 }]);
  });
});

describe("on a weak connection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const later = (ms: number, body: unknown) =>
    fetchMock.mockImplementationOnce(
      (_url: string, { signal }: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve({ ok: true, status: 200, json: async () => body }), ms);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );

  it("waits for a slow answer (8 s) instead of calling search unavailable", async () => {
    later(8000, { features: [feature("Tofino", -125.9, 49.15)] });
    const found = searchPlaces("tofino");
    await vi.advanceTimersByTimeAsync(8000);
    await expect(found).resolves.toHaveLength(1);
  });

  it("gives up only after 15 s, as unavailable, not offline", async () => {
    later(60_000, { features: [] });
    const found = searchPlaces("tofino");
    const check = expect(found).rejects.toMatchObject({ message: "timeout" });
    await vi.advanceTimersByTimeAsync(15_000);
    await check;
  });
});
