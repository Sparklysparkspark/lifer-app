// Small input checks for route params and bodies, so malformed ids and dates get a 400
// instead of reaching a Postgres cast and surfacing as a 500.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// Returns a Date for a parseable ISO-ish string, null for empty input, undefined when invalid.
export function parseDate(value: unknown): Date | null | undefined {
  if (value == null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// Parses a positive integer query param, clamped to [1, max]. Falls back to `fallback`.
export function parseLimit(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}
