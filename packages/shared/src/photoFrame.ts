// Composition and light read from what the hub stores per photo (capture_frames): the detector's
// subject box, the photo's aspect and its light stats. Deterministic and shared with the phone, so
// both sides answer "rule of thirds" or "blue hour" the same way.
import type { CompositionReading, TimeOfDay } from "./searchTerms.js";
import { sunFits, sunPosition } from "./sun.js";

/** The subject box [x1, y1, x2, y2] as fractions of the upright photo. */
export type FrameBox = [number, number, number, number];

/** Light stats of the whole photo, from a small downscale: mean brightness (0 to 1), warm minus
 *  cool cast (mean red minus blue, -1 to 1), shares of near-white and near-black pixels, and mean
 *  colourfulness (HSV saturation). */
export interface LightStats {
  luma: number;
  warmth: number;
  highlights: number;
  shadows: number;
  saturation: number;
}

export type SubjectSize = "tiny" | "small" | "medium" | "frameFilling";
export type Orientation = "horizontal" | "vertical" | "square";

export interface Composition {
  size: SubjectSize;
  thirds: boolean;
  goldenRatio: boolean;
  centred: boolean;
}

// Share of the frame the box covers at each size step.
const TINY_SHARE = 0.015;
const SMALL_SHARE = 0.1;
const FRAME_FILLING_SHARE = 0.35;
// How far the box centre may sit from a grid intersection, as a fraction of the frame. The phi grid's
// lines are 0.049 from the thirds lines, so its tolerance is tighter: an exact thirds point isn't phi.
const THIRDS_TOLERANCE = 0.07;
const PHI_TOLERANCE = 0.04;
const PHI_LINE = 1 - 1 / ((1 + Math.sqrt(5)) / 2); // 0.382
const CENTRE_TOLERANCE_X = 0.06;
const CENTRE_TOLERANCE_Y = 0.08;

export function orientationOf(aspect: number): Orientation {
  return aspect > 1.05 ? "horizontal" : aspect < 0.95 ? "vertical" : "square";
}

/** Where the subject sits and how much of the frame it fills. Placement needs room to place: a
 *  frame-filling subject is never on a grid point. */
export function compositionOf(box: FrameBox): Composition {
  const [x1, y1, x2, y2] = box;
  const share = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const size: SubjectSize =
    share < TINY_SHARE
      ? "tiny"
      : share < SMALL_SHARE
        ? "small"
        : share < FRAME_FILLING_SHARE
          ? "medium"
          : "frameFilling";
  const onGrid = (lines: number[], tol: number) =>
    size !== "frameFilling" && lines.some((l) => Math.abs(cx - l) <= tol) && lines.some((l) => Math.abs(cy - l) <= tol);
  return {
    size,
    thirds: onGrid([1 / 3, 2 / 3], THIRDS_TOLERANCE),
    goldenRatio: onGrid([PHI_LINE, 1 - PHI_LINE], PHI_TOLERANCE),
    centred: Math.abs(cx - 0.5) <= CENTRE_TOLERANCE_X && Math.abs(cy - 0.5) <= CENTRE_TOLERANCE_Y,
  };
}

/** Whether a photo fits a composition word. Null when it can't be told: no sure subject box for
 *  placement and size words, no aspect for orientation. */
export function compositionFits(
  reading: CompositionReading,
  frame: { box: FrameBox | null; unsure: boolean; aspect: number | null },
): boolean | null {
  if (reading === "vertical" || reading === "horizontal") {
    return frame.aspect ? orientationOf(frame.aspect) === reading : null;
  }
  if (!frame.box || frame.unsure) return null;
  const c = compositionOf(frame.box);
  switch (reading) {
    case "ruleOfThirds":
      return c.thirds;
    case "goldenRatio":
      return c.goldenRatio;
    case "centred":
      return c.centred;
    case "smallInFrame":
      return c.size === "tiny" || c.size === "small";
    case "frameFilling":
      return c.size === "frameFilling";
  }
}

/** What a row needs for the sun and light readings below. */
export interface LightRow {
  taken_at: Date | string | null;
  lat?: number | string | null;
  lon?: number | string | null;
  /** False when the file gave no time zone; null or absent when it isn't known (older imports). */
  taken_at_zoned?: boolean | null;
}

/** Where the sun was, when the photo's place and time can be trusted for it: GPS, a time, and no
 *  sign the time zone was missing. */
export function trustedSun(r: LightRow): { elevation: number; solarHour: number } | null {
  if (r.lat == null || r.lon == null || !r.taken_at || r.taken_at_zoned === false) return null;
  return sunPosition(new Date(String(r.taken_at)), Number(r.lat), Number(r.lon));
}

// A plainly daylit photo: bright, few deep shadows, and in colour (infrared trail cameras shoot
// bright grey frames at night).
const DAYLIT_LUMA = 0.35;
const DAYLIT_MAX_SHADOWS = 0.2;
const DAYLIT_MIN_SATURATION = 0.15;
// The sun this far below the horizon leaves no daylight to photograph by.
const DARK_SUN_ELEVATION = -8;

/** The photo's time is probably wrong: the sun was well down, yet the photo is plainly daylit. Only
 *  this way round: a dark photo in daylight is common (indoors, flash, deep shade, low key). */
export function timeMaybeWrong(sun: { elevation: number } | null, light: LightStats | null | undefined): boolean {
  if (!sun || !light) return false;
  return (
    sun.elevation < DARK_SUN_ELEVATION &&
    light.luma >= DAYLIT_LUMA &&
    light.shadows <= DAYLIT_MAX_SHADOWS &&
    light.saturation >= DAYLIT_MIN_SATURATION
  );
}

/** Whether a photo's own light could be this time of day. A veto on the picture model's reading,
 *  never a match by itself: the stats can't tell a dark forest from dusk. */
export function lightAllows(t: TimeOfDay, light: LightStats | null | undefined): boolean {
  if (!light) return true;
  switch (t) {
    case "night":
      return light.luma <= 0.25;
    case "blueHour":
      return light.luma <= 0.45 && light.warmth <= 0.02;
    case "twilight":
      return light.luma <= 0.5;
    case "goldenHour":
    case "sunrise":
    case "sunset":
      return light.warmth >= 0.03;
    case "midday":
      return light.luma >= 0.25;
    case "morning":
    case "afternoon":
    case "evening":
      return true;
  }
}

/** How a time of day is decided for one photo: by the trusted sun (exact), or left to the picture
 *  (null) when there's no trusted sun or the photo's light says its time is wrong. */
export function sunDecides(t: TimeOfDay, r: LightRow & { light_stats?: LightStats | null }): boolean | null {
  const sun = trustedSun(r);
  if (!sun || timeMaybeWrong(sun, r.light_stats)) return null;
  return sunFits(t, sun);
}
