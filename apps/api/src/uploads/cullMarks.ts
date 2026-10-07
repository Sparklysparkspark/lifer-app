// Culling marks: the pick/reject verdict and colour label a dedicated culling app left in a
// photo's metadata, normalized across apps. Read at import, from the file itself and from its
// ".xmp" sidecar, and for a RAW+JPEG pair from both files. Reading only: Lifer never changes or
// deletes a file because of a mark. Which app writes which field is in
// docs/docs/guides/culling-with-other-apps.md.
import { CULL_LABELS, type CullLabel, type CullMarks, type CullMarksOption, type CullVerdict } from "@lifer/shared";
import { findSidecarPath, readCullTags } from "./exif.js";

export const NO_CULL_MARKS: CullMarks = Object.freeze({ verdict: null, label: null });

function int(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  // exiftool's printed form can carry a description, like "2 (Winner alt)".
  const match = /^\s*(-?\d+)\b/.exec(value);
  return match ? Number(match[1]) : null;
}

function truthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === "string" && /^(yes|true|1)$/i.test(value.trim());
}

function falsy(value: unknown): boolean {
  if (value === false || value === 0) return true;
  return typeof value === "string" && /^(no|false|0)$/i.test(value.trim());
}

// Lightroom, Capture One, digiKam and SuperPicky write the colour's English name (digiKam writes
// "NoColor" for none). Adobe Bridge writes its label text, whose defaults are "Select", "Second",
// "Approved", "Review" and "To Do", in the order of its red to purple labels. Anything else (a
// custom label set, a translated name) isn't a colour Lifer can be sure of, so it's left out.
const LABEL_NAMES: Record<string, CullLabel> = {
  red: "red",
  orange: "orange",
  yellow: "yellow",
  green: "green",
  blue: "blue",
  purple: "purple",
  magenta: "purple",
  violet: "purple",
  gray: "gray",
  grey: "gray",
  black: "black",
  white: "white",
  select: "red",
  second: "yellow",
  approved: "green",
  review: "blue",
  "to do": "purple",
};

// digiKam's ColorLabel numbers (0 is none).
const DIGIKAM_COLORS: Array<CullLabel | null> = [
  null,
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "gray",
  "black",
  "white",
];

function labelFromText(value: unknown): CullLabel | null {
  if (typeof value !== "string") return null;
  return LABEL_NAMES[value.trim().toLowerCase()] ?? null;
}

// Photo Mechanic's Prefs packs "tagged:colorclass:rating:frame" ("1:2:3:000123"), printed by
// exiftool as "Tagged:1, ColorClass:2, Rating:3, FrameNum:000123".
function prefsTagged(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const named = /Tagged:\s*(\d+)/i.exec(value);
  if (named) return named[1] !== "0";
  const packed = /^\s*(\d+):/.exec(value);
  return packed ? packed[1] !== "0" : false;
}

/** The verdict and label in one file's tags, as exiftool reads them (bare tag names). */
export function cullMarksFromTags(tags: Record<string, unknown>): CullMarks {
  const verdicts = new Set<CullVerdict>();

  // xmp:Rating -1 is "rejected" in the XMP spec, written by Bridge, FastRawViewer and others.
  if (int(tags.Rating) === -1) verdicts.add("reject");

  // The flag Lightroom Classic 13.2 and later, Lightroom desktop, digiKam, Vireo and SuperPicky
  // write: xmpDM:pick 1 flagged, -1 rejected, and xmpDM:good True or False alongside it.
  const flag = int(tags.Pick);
  if (flag === -1) verdicts.add("reject");
  else if (flag === 1) verdicts.add("pick");
  if (tags.Good !== undefined && tags.Good !== null) {
    if (truthy(tags.Good)) verdicts.add("pick");
    else if (falsy(tags.Good)) verdicts.add("reject");
  }

  // digiKam's pick label: 1 rejected, 2 pending, 3 accepted.
  const pick = int(tags.PickLabel);
  if (pick === 1) verdicts.add("reject");
  else if (pick === 3) verdicts.add("pick");

  // Photo Mechanic's tag (its keeper mark), on its own or packed into Prefs.
  if (tags.Tagged !== undefined ? truthy(tags.Tagged) : prefsTagged(tags.Prefs)) verdicts.add("pick");

  const label = labelFromText(tags.Label) ?? DIGIKAM_COLORS[int(tags.ColorLabel) ?? 0] ?? null;

  return { verdict: verdicts.has("reject") ? "reject" : verdicts.has("pick") ? "pick" : null, label };
}

/**
 * Combines the marks of files that are one photo (a file and its sidecar, or a RAW and its JPEG).
 * A reject on any of them wins, since it's the deliberate one: a pick or nothing on the twin is
 * usually just a file the culling app didn't write to. The first label found is kept.
 */
export function mergeCullMarks(...marks: CullMarks[]): CullMarks {
  const verdicts = marks.map((m) => m.verdict);
  return {
    verdict: verdicts.includes("reject") ? "reject" : verdicts.includes("pick") ? "pick" : null,
    label: marks.find((m) => m.label)?.label ?? null,
  };
}

async function marksOf(filePath: string): Promise<CullMarks> {
  try {
    return cullMarksFromTags(await readCullTags(filePath));
  } catch {
    return NO_CULL_MARKS; // an unreadable file or sidecar just carries no marks
  }
}

/** One file's marks: its own metadata and its ".xmp" sidecar (the sidecar's label first, since
 *  that's where Lightroom and others write for a RAW). */
export async function readCullMarks(filePath: string): Promise<CullMarks> {
  const sidecar = findSidecarPath(filePath);
  const own = await marksOf(filePath);
  return sidecar ? mergeCullMarks(await marksOf(sidecar), own) : own;
}

/** A photo's marks with its RAW twin's, so a verdict on either file applies to the pair. */
export async function readPairCullMarks(photoPath: string, rawPath: string | null): Promise<CullMarks> {
  const photo = await readCullMarks(photoPath);
  return rawPath ? mergeCullMarks(photo, await readCullMarks(rawPath)) : photo;
}

/** What an import does with a photo carrying these marks, given the import's option. */
export function cullDecision(marks: CullMarks, option: CullMarksOption): "import" | "hide" | "skip" {
  if (marks.verdict !== "reject" || option === "ignore") return "import";
  return option;
}

export function isCullLabel(value: unknown): value is CullLabel {
  return typeof value === "string" && (CULL_LABELS as readonly string[]).includes(value);
}
