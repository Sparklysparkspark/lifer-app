// Where the sun stood when a photo was taken, from its coordinates and time: the low-precision
// solar position from the Astronomical Almanac, good to about a degree, plenty for "golden hour".
import type { TimeOfDay } from "./searchTerms.js";

const RAD = Math.PI / 180;

/** The sun's elevation above the horizon in degrees, and the local solar time in hours (12 is
 *  solar noon). */
export function sunPosition(at: Date, lat: number, lon: number): { elevation: number; solarHour: number } {
  // Days since J2000.0 (2000-01-01 12:00 UTC).
  const d = at.getTime() / 86_400_000 - 10_957.5;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const eclipticLon = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const tilt = (23.439 - 0.00000036 * d) * RAD;
  const declination = Math.asin(Math.sin(tilt) * Math.sin(eclipticLon));
  const rightAscension = Math.atan2(Math.cos(tilt) * Math.sin(eclipticLon), Math.cos(eclipticLon)) / RAD;
  const siderealDeg = (18.697374558 + 24.06570982441908 * d) * 15 + lon;
  // Hour angle in -180..180: negative before solar noon.
  const hourAngle = ((((siderealDeg - rightAscension) % 360) + 540) % 360) - 180;
  const elevation =
    Math.asin(
      Math.sin(lat * RAD) * Math.sin(declination) +
        Math.cos(lat * RAD) * Math.cos(declination) * Math.cos(hourAngle * RAD),
    ) / RAD;
  return { elevation, solarHour: 12 + hourAngle / 15 };
}

export type { TimeOfDay };

/** Whether the sun's position fits a time of day. Light classes go by the sun's elevation, never the
 *  clock, so they hold at any latitude (blue hour at 2 am in an Arctic June). */
export function sunFits(t: TimeOfDay, { elevation, solarHour }: { elevation: number; solarHour: number }): boolean {
  const lowSun = elevation >= -4 && elevation <= 6;
  switch (t) {
    case "goldenHour":
      return lowSun;
    case "sunrise":
      return lowSun && solarHour < 12;
    case "sunset":
      return lowSun && solarHour >= 12;
    case "blueHour":
      return elevation >= -6 && elevation < -4;
    case "twilight":
      return elevation >= -6 && elevation < 0;
    case "night":
      return elevation < -6;
    case "morning":
      return solarHour >= 5 && solarHour < 11;
    case "midday":
      return solarHour >= 11 && solarHour < 13;
    case "afternoon":
      return solarHour >= 13 && solarHour < 17;
    case "evening":
      return solarHour >= 17 && solarHour < 21;
  }
}
