import type { CullLabel, CullMarks, CullMarksOption, CullVerdict } from "@lifer/shared";

/** What a culling app marked a photo, as one short line for the lightbox ("Picked in your
 *  culling app · Red label"), or null when it left no mark. */
export function cullInfo(verdict: CullVerdict | null | undefined, label: CullLabel | null | undefined): string | null {
  const parts = [
    verdict === "pick" ? "Picked in your culling app" : verdict === "reject" ? "Rejected in your culling app" : null,
    label ? `${label[0].toUpperCase()}${label.slice(1)} label` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function isRejected(row: { cull?: CullMarks | null }): boolean {
  return row.cull?.verdict === "reject";
}

/** The status line a rejected row shows, or null for one the culling app didn't reject. */
export function rejectedRowNote(row: { cull?: CullMarks | null }, option: CullMarksOption): string | null {
  if (!isRejected(row)) return null;
  if (option === "skip") return "Rejected in your culling app, won't be imported";
  if (option === "hide") return "Rejected in your culling app, will be imported hidden";
  return "Rejected in your culling app";
}
