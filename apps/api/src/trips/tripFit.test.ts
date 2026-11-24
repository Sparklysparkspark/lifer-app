import { describe, expect, it } from "vitest";
import { distanceKm, fitsTrip, tripSpan, tripsToOffer, type ImportGroup, type TripFacts } from "./tripFit.js";

const NOW = new Date("2026-11-23T12:00:00Z");
const costaRica = { lat: 8.54, lon: -83.5 };
const trip = (over: Partial<TripFacts> = {}): TripFacts => ({
  id: "t1",
  startDate: "2026-05-03",
  endDate: "2026-05-10",
  firstTaken: null,
  lastTaken: null,
  regionIds: [],
  points: [],
  ...over,
});
const group = (times: string[], over: Partial<ImportGroup> = {}): ImportGroup => ({
  times: times.map((t) => new Date(t)),
  points: [],
  regionIds: [],
  ...over,
});

describe("tripFit", () => {
  it("spans the trip's dates widened to its photos, and an open trip runs until now", () => {
    const span = tripSpan(trip({ lastTaken: new Date("2026-05-12T08:00:00Z") }), NOW)!;
    expect(new Date(span.from).toISOString()).toBe("2026-05-03T00:00:00.000Z");
    expect(new Date(span.to).toISOString()).toBe("2026-05-12T08:00:00.000Z");
    expect(tripSpan(trip({ endDate: null }), NOW)!.to).toBe(NOW.getTime());
    expect(tripSpan(trip({ startDate: null, endDate: null }), NOW)).toBeNull();
  });

  it("fits by date with a day either side, every photo inside", () => {
    expect(fitsTrip(group(["2026-05-02T06:00:00Z", "2026-05-11T20:00:00Z"]), trip(), NOW)).toBe(true);
    expect(fitsTrip(group(["2026-05-01T23:00:00Z"]), trip(), NOW)).toBe(false);
    expect(fitsTrip(group(["2026-05-05T10:00:00Z", "2026-06-01T10:00:00Z"]), trip(), NOW)).toBe(false);
    expect(fitsTrip(group([]), trip(), NOW)).toBe(false);
  });

  it("with GPS, must also be near the trip's photos or in its region", () => {
    const located = trip({ points: [costaRica], regionIds: ["cr"] });
    const at = (p: { lat: number; lon: number }, regionIds: string[] = []) =>
      group(["2026-05-05T10:00:00Z"], { points: [p], regionIds });
    expect(fitsTrip(at({ lat: 8.9, lon: -83.2 }), located, NOW)).toBe(true);
    expect(fitsTrip(at({ lat: 49.2, lon: -123.1 }), located, NOW)).toBe(false);
    expect(fitsTrip(at({ lat: 10.0, lon: -85.0 }, ["guanacaste", "cr"]), located, NOW)).toBe(true);
    // A trip with no place known is judged by date alone.
    expect(fitsTrip(at({ lat: 49.2, lon: -123.1 }), trip(), NOW)).toBe(true);
    expect(distanceKm(costaRica, { lat: 9.44, lon: -83.5 })).toBeCloseTo(100, 0);
  });

  it("offers one trip by date alone, up to two with GPS, and nothing when less clear", () => {
    const a = trip({ id: "a" });
    const b = trip({ id: "b", startDate: "2026-05-01", endDate: "2026-05-12" });
    const c = trip({ id: "c", startDate: "2026-04-30", endDate: "2026-05-20" });
    const noGps = group(["2026-05-05T10:00:00Z"]);
    expect(tripsToOffer(noGps, [a], NOW).map((t) => t.id)).toEqual(["a"]);
    expect(tripsToOffer(noGps, [a, b], NOW)).toEqual([]);
    const gps = group(["2026-05-05T10:00:00Z"], { points: [costaRica] });
    expect(tripsToOffer(gps, [a, b], NOW).map((t) => t.id)).toEqual(["a", "b"]);
    expect(tripsToOffer(gps, [a, b, c], NOW)).toEqual([]);
    expect(tripsToOffer(group(["2027-01-01T00:00:00Z"]), [a], NOW)).toEqual([]);
  });
});
