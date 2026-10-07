// Culling marks: the verdict a dedicated culling app (Lightroom, Photo Mechanic, digiKam, Vireo
// and others) left in a photo's metadata, read at import time. See
// docs/docs/guides/culling-with-other-apps.md for which fields each app writes.

/** A culling app's verdict on a photo: kept ("pick") or thrown out ("reject"). */
export type CullVerdict = "pick" | "reject";

/** Colour labels, named the way Lightroom does, plus digiKam's extra gray, black and white. */
export const CULL_LABELS = ["red", "orange", "yellow", "green", "blue", "purple", "gray", "black", "white"] as const;
export type CullLabel = (typeof CULL_LABELS)[number];

/** What a photo's metadata (and its sidecar, and its RAW+JPEG twin) says. */
export interface CullMarks {
  verdict: CullVerdict | null;
  label: CullLabel | null;
}

/**
 * What an import does with photos a culling app rejected:
 * - "skip": leave them out (the default in the app's import screens);
 * - "hide": import them hidden, out of the gallery, the life list and the stats until unhidden;
 * - "ignore": import them like any other photo.
 */
export const CULL_MARKS_OPTIONS = ["skip", "hide", "ignore"] as const;
export type CullMarksOption = (typeof CULL_MARKS_OPTIONS)[number];
