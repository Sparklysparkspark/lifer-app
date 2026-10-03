export type DateStyle = "short" | "medium" | "long" | "monthYear" | "dateTime";

const OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { year: "numeric", month: "numeric", day: "numeric" },
  medium: { year: "numeric", month: "short", day: "numeric" },
  long: { year: "numeric", month: "long", day: "numeric" },
  monthYear: { year: "numeric", month: "long" },
  dateTime: { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Building a formatter is the slow part, and grids format thousands of dates per render.
const defaultLocaleFormatters = new Map<DateStyle, Intl.DateTimeFormat>();
function formatterFor(style: DateStyle, locale?: string | string[]): Intl.DateTimeFormat {
  if (locale) return new Intl.DateTimeFormat(locale, OPTIONS[style]);
  let formatter = defaultLocaleFormatters.get(style);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, OPTIONS[style]);
    defaultLocaleFormatters.set(style, formatter);
  }
  return formatter;
}

export function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  // A bare "2024-05-01" parses as UTC midnight, which shows as the day before west of UTC.
  const dateOnly = typeof value === "string" ? DATE_ONLY.exec(value) : null;
  const date = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Formats a date in the user's locale. Returns "" for null, empty or unparseable input. */
export function formatDate(
  value: Date | string | number | null | undefined,
  style: DateStyle = "medium",
  locale?: string | string[],
): string {
  const date = toDate(value);
  if (!date) return "";
  return formatterFor(style, locale).format(date);
}
