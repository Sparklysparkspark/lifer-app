// Every date, number, percentage, byte size, relative time and list in the interface is formatted
// here, through Intl, in the locale the i18n module picks (i18n/index.ts calls setFormatLocale on
// every language change: the interface language, or the system's regional variant of it, like en-GB).
// Until then, and in unit tests, the runtime's default locale is used.

let currentLocale: string | undefined;

/** Called by the i18n module when the interface language changes. */
export function setFormatLocale(locale: string | undefined): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  dateFormatters.clear();
  numberFormatters.clear();
}

/** The locale formatting currently follows (undefined: the runtime's default). */
export function getFormatLocale(): string | undefined {
  return currentLocale;
}

// --- Dates ---

export type DateStyle = "short" | "medium" | "long" | "monthYear" | "dateTime" | "time" | "monthDay" | "month";

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { year: "numeric", month: "numeric", day: "numeric" },
  medium: { year: "numeric", month: "short", day: "numeric" },
  long: { year: "numeric", month: "long", day: "numeric" },
  monthYear: { year: "numeric", month: "long" },
  dateTime: { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  time: { hour: "numeric", minute: "2-digit" },
  monthDay: { month: "short", day: "numeric" },
  month: { month: "short" },
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Building a formatter is the slow part, and grids format thousands of dates per render.
const dateFormatters = new Map<DateStyle, Intl.DateTimeFormat>();
function dateFormatterFor(style: DateStyle, locale?: string | string[]): Intl.DateTimeFormat {
  if (locale) return new Intl.DateTimeFormat(locale, DATE_OPTIONS[style]);
  let formatter = dateFormatters.get(style);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(currentLocale, DATE_OPTIONS[style]);
    dateFormatters.set(style, formatter);
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

/** Formats a date in the active locale. Returns "" for null, empty or unparseable input. */
export function formatDate(
  value: Date | string | number | null | undefined,
  style: DateStyle = "medium",
  locale?: string | string[],
): string {
  const date = toDate(value);
  if (!date) return "";
  return dateFormatterFor(style, locale).format(date);
}

/** A month's name (0 = January) in the active locale, in the given width. */
export function formatMonthName(
  monthIndex: number,
  width: "long" | "short" | "narrow" = "long",
  locale?: string,
): string {
  return new Intl.DateTimeFormat(locale ?? currentLocale, { month: width, timeZone: "UTC" }).format(
    new Date(Date.UTC(2000, monthIndex, 1)),
  );
}

// --- Relative time ---

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** "3 days ago", "in 2 hours", "yesterday", in the active locale. "" for an unparseable date. */
export function formatRelativeTime(
  value: Date | string | number | null | undefined,
  now: Date | number = Date.now(),
  locale?: string,
): string {
  const date = toDate(value);
  if (!date) return "";
  const seconds = Math.round((date.getTime() - (typeof now === "number" ? now : now.getTime())) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale ?? currentLocale, { numeric: "auto" });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size || unit === "second") return rtf.format(Math.round(seconds / size), unit);
  }
  return "";
}

// --- Numbers ---

const numberFormatters = new Map<string, Intl.NumberFormat>();
function numberFormatterFor(options: Intl.NumberFormatOptions = {}, locale?: string): Intl.NumberFormat {
  if (locale) return new Intl.NumberFormat(locale, options);
  const key = JSON.stringify(options);
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(currentLocale, options);
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

/** A number with the active locale's grouping and decimal separator: 1200 -> "1,200". */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions, locale?: string): string {
  return numberFormatterFor(options, locale).format(value);
}

/** A fraction as a whole percentage in the active locale: 0.45 -> "45%" (or "45 %" in French). */
export function formatPercent(fraction: number, options?: Intl.NumberFormatOptions, locale?: string): string {
  return numberFormatterFor({ style: "percent", maximumFractionDigits: 0, ...options }, locale).format(fraction);
}

// One byte format for the whole app: decimal units (like Finder), one decimal only for small numbers.
// 950 -> "950 B", 47_300_000 -> "47.3 MB", 312_000_000 -> "312 MB". The unit symbols are SI and
// stay the same in every language; only the number follows the locale.
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number, locale?: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${formatNumber(0, undefined, locale)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${formatNumber(value, { maximumFractionDigits: digits }, locale)} ${BYTE_UNITS[unit]}`;
}

// --- Lists ---

/** "a, b and c" in the active locale. */
export function formatList(
  items: readonly string[],
  type: Intl.ListFormatType = "conjunction",
  locale?: string,
): string {
  return new Intl.ListFormat(locale ?? currentLocale, { style: "long", type }).format(items);
}
