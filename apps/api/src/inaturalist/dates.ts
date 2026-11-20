import { dateOnlyToTakenAt } from "@lifer/shared";

/** iNaturalist's observed_on ("2026-06-04") as a capture's taken_at, stored like a date typed for a
 *  photo with none. Null for anything that isn't a plain calendar date. */
export function observedOnToTakenAt(observedOn: string | null): string | null {
  return dateOnlyToTakenAt(observedOn);
}

/** What iNaturalist is told for when a photo was taken. A file that named its time zone has a true
 *  instant. Otherwise Lifer holds the camera's clock reading as if it were UTC, so that reading goes
 *  with no zone and iNaturalist shows it as the local time it was. A bare day typed in Lifer
 *  (stored at noon UTC) goes as just the day. */
export function observedOnString(takenAt: Date | string | null, zoned: boolean | null): string | null {
  if (takenAt === null) return null;
  const at = new Date(takenAt);
  if (Number.isNaN(at.getTime())) return null;
  const iso = at.toISOString();
  if (zoned) return iso;
  if (iso.slice(11) === "12:00:00.000Z") return iso.slice(0, 10);
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}
