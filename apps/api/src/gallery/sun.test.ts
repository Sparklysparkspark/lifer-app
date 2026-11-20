import { describe, expect, it } from "vitest";
import { sunFits, sunPosition } from "./sun.js";

// Greenwich Observatory.
const LAT = 51.4769;
const LON = 0;

describe("sunPosition", () => {
  it("matches the sun's noon height at the solstices", () => {
    // 90 - latitude +/- the axial tilt.
    expect(sunPosition(new Date("2024-06-20T12:00:00Z"), LAT, LON).elevation).toBeCloseTo(61.96, 0);
    expect(sunPosition(new Date("2024-12-21T12:00:00Z"), LAT, LON).elevation).toBeCloseTo(15.08, 0);
  });

  it("puts the sun at the horizon at sunrise and below it at midnight", () => {
    // Sunrise in London on the 2024 March equinox was 06:03 UTC.
    const dawn = sunPosition(new Date("2024-03-20T06:03:00Z"), LAT, LON);
    expect(Math.abs(dawn.elevation)).toBeLessThan(1.5);
    expect(dawn.solarHour).toBeCloseTo(6.1, 0);
    expect(sunPosition(new Date("2024-03-20T00:00:00Z"), LAT, LON).elevation).toBeLessThan(-30);
  });

  it("uses the longitude for solar time", () => {
    // Solar noon in Denver (105W) is about 19:00 UTC.
    const denver = sunPosition(new Date("2024-06-20T19:00:00Z"), 39.74, -104.99);
    expect(denver.solarHour).toBeCloseTo(12, 0);
    expect(denver.elevation).toBeGreaterThan(70);
  });
});

describe("sunFits", () => {
  it("tells sunrise from sunset by solar time, and night by the sun's depth", () => {
    expect(sunFits("sunrise", { elevation: 2, solarHour: 6 })).toBe(true);
    expect(sunFits("sunset", { elevation: 2, solarHour: 6 })).toBe(false);
    expect(sunFits("goldenHour", { elevation: 5, solarHour: 19 })).toBe(true);
    expect(sunFits("goldenHour", { elevation: 20, solarHour: 16 })).toBe(false);
    expect(sunFits("night", { elevation: -10, solarHour: 23 })).toBe(true);
    expect(sunFits("night", { elevation: -3, solarHour: 20 })).toBe(false);
  });
});
