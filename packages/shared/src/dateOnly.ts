/** A calendar day ("2026-06-04") as a photo's taken_at: noon UTC, so it reads as that day in every
 *  time zone from UTC-12 to UTC+11 (midnight UTC shows as the day before west of UTC). Null for
 *  anything that isn't a real day, such as 2026-02-31. */
export function dateOnlyToTakenAt(day: string | null | undefined): string | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? null : date.toISOString();
}
