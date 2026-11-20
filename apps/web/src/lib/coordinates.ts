// Reads a latitude and longitude typed or pasted by hand: decimal degrees ("49.2827, -123.1207"),
// degrees minutes seconds as Google Maps copies them (49°16'57.7"N 123°07'14.5"W), Apple Maps'
// "49.2827° N, 123.1207° W", and degrees with decimal minutes (49 16.962 N, 123 7.242 W).

export type CoordinatesResult =
  | { ok: true; lat: number; lon: number }
  | { ok: false; reason: "empty" | "unreadable" | "latRange" | "lonRange" | "hemisphere" };

interface Part {
  value: number;
  hemisphere: "N" | "S" | "E" | "W" | null;
}

const NUMBER = String.raw`[-+−]?\d+(?:\.\d+)?`;
// One coordinate: up to three numbers (degrees, minutes, seconds) with any degree, minute or
// second marks, and a hemisphere letter before or after.
const PART = new RegExp(
  String.raw`^([NSEW])?\s*(${NUMBER})\s*(?:[°º˚]|deg)?\s*(?:(\d+(?:\.\d+)?)\s*['′’‘]?\s*(?:(\d+(?:\.\d+)?)\s*(?:["″”“]|''|′′)?)?)?\s*([NSEW])?$`,
  "i",
);

function readPart(text: string): Part | null {
  const m = PART.exec(text.trim());
  if (!m) return null;
  const [, before, deg, min, sec, after] = m;
  if (before && after) return null;
  const degrees = Number(deg.replace("−", "-"));
  const minutes = min ? Number(min) : 0;
  const seconds = sec ? Number(sec) : 0;
  // Minutes and seconds only follow whole degrees, and stay under 60.
  if ((min || sec) && !Number.isInteger(degrees)) return null;
  if (minutes >= 60 || seconds >= 60) return null;
  const negative = /^[-−]/.test(deg);
  const value = Math.abs(degrees) + minutes / 60 + seconds / 3600;
  const hemisphere = ((before || after)?.toUpperCase() ?? null) as Part["hemisphere"];
  if (negative && hemisphere) return null;
  return { value: negative ? -value : value, hemisphere };
}

/** Splits a pair into its two halves: on a comma or semicolon, else after a N or S, else before
 *  an E or W that starts the second half, else on the space between two plain numbers. */
function splitPair(text: string): [string, string] | null {
  const bySeparator = text.split(/\s*[,;]\s*/);
  if (bySeparator.length === 2) return [bySeparator[0], bySeparator[1]];
  if (bySeparator.length > 2) return null;
  const afterLetter = /^(.*?\d.*?\b[NS]\b)\s*(.+)$/i.exec(text);
  if (afterLetter) return [afterLetter[1], afterLetter[2]];
  const letterFirst = /^([NS]\b.*?)\s+([EW]\b.*)$/i.exec(text);
  if (letterFirst) return [letterFirst[1], letterFirst[2]];
  const plain = text.split(/\s+/);
  if (plain.length === 2) return [plain[0], plain[1]];
  return null;
}

export function parseCoordinates(input: string): CoordinatesResult {
  const text = input
    .replace(/\u00a0/g, " ")
    .replace(/[()]/g, " ")
    .trim();
  if (!text) return { ok: false, reason: "empty" };
  const halves = splitPair(text);
  const a = halves && readPart(halves[0]);
  const b = halves && readPart(halves[1]);
  if (!a || !b) return { ok: false, reason: "unreadable" };
  // Longitude first only when the letters say so ("123.12 W 49.28 N").
  const [latPart, lonPart] = a.hemisphere === "E" || a.hemisphere === "W" ? [b, a] : [a, b];
  if (
    (latPart.hemisphere && !"NS".includes(latPart.hemisphere)) ||
    (lonPart.hemisphere && !"EW".includes(lonPart.hemisphere))
  )
    return { ok: false, reason: "hemisphere" };
  const lat = latPart.hemisphere === "S" ? -latPart.value : latPart.value;
  const lon = lonPart.hemisphere === "W" ? -lonPart.value : lonPart.value;
  if (Math.abs(lat) > 90) return { ok: false, reason: "latRange" };
  if (Math.abs(lon) > 180) return { ok: false, reason: "lonRange" };
  return { ok: true, lat: round6(lat), lon: round6(lon) };
}

// Six decimals is about 10 cm, finer than any camera's GPS.
const round6 = (n: number) => Math.round(n * 1e6) / 1e6 + 0;

/** "49.282700, -123.120700" style, for showing a stored point. */
export function formatCoordinates(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}
