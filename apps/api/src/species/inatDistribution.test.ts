import { afterEach, describe, expect, it, vi } from "vitest";

const httpFetch = vi.fn();
vi.mock("@lifer/core/lib/http.js", () => ({ httpFetch: (url: string) => httpFetch(url) }));
vi.mock("@lifer/core/db.js", () => ({ pool: {} }));

const { fetchWeekly } = await import("./inatDistribution.js");

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const box = {
  type: "Polygon",
  coordinates: [
    [
      [-139, 48.3],
      [-114, 48.3],
      [-114, 60],
      [-139, 60],
      [-139, 48.3],
    ],
  ],
};

afterEach(() => httpFetch.mockReset());

describe("fetchWeekly", () => {
  it("asks for the region's iNaturalist place and folds week 53 into the last week", async () => {
    httpFetch.mockResolvedValueOnce(json({ results: { week_of_year: { 1: 3, 20: 505, 52: 1, 53: 2 } } }));
    const weeks = await fetchWeekly(319125, { id: "r", name: "BC", inat_place_id: 7085, boundary_geojson: box });
    expect(httpFetch.mock.calls[0][0]).toContain("place_id=7085");
    expect(weeks).toHaveLength(52);
    expect([weeks![0], weeks![19], weeks![51]]).toEqual([3, 505, 3]);
  });

  it("uses the bounding box without a place, and null when there are no records", async () => {
    httpFetch.mockResolvedValueOnce(json({ results: { week_of_year: { 1: 0 } } }));
    const weeks = await fetchWeekly(319125, { id: "r", name: "BC", inat_place_id: null, boundary_geojson: box });
    expect(httpFetch.mock.calls[0][0]).toContain("swlat=48.3&swlng=-139&nelat=60&nelng=-114");
    expect(weeks).toBeNull();
  });
});
