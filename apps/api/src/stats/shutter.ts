// ShutterSpeed comes back as decimal seconds ("0.0005") or a fraction ("1/2000"); handle both.
export function parseShutterSeconds(raw: string): number | null {
  const fraction = raw.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator > 0 ? Number(fraction[1]) / denominator : null;
  }
  const plain = Number(raw);
  return Number.isFinite(plain) && plain > 0 ? plain : null;
}

/** parseShutterSeconds in SQL, for bucketing in the database. Digit counts are bounded so a junk
 *  value can't overflow float8 and fail the whole query. */
export function shutterSecondsSql(column: string): string {
  return String.raw`(CASE
    WHEN ${column} ~ '^\d{1,15}(\.\d{1,15})?\s*/\s*\d{1,15}(\.\d{1,15})?$'
      THEN split_part(${column}, '/', 1)::float8 / NULLIF(split_part(${column}, '/', 2)::float8, 0)
    WHEN ${column} ~ '^\s*(\d{1,15}(\.\d{0,15})?|\.\d{1,15})([eE][-+]?\d{1,2})?\s*$'
      THEN CASE WHEN ${column}::float8 > 0 THEN ${column}::float8 END
  END)`;
}
