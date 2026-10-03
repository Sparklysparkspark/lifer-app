// Turns a country's admin-1 type (Natural Earth's "State", "Region", "Oblast", ..., stored on
// regions.subdivision_type) into the plural label for its children, e.g. "States" for the US.

// A handful of Natural Earth's raw values are already non-English, or need a nicer word than a
// literal pluralization. Everything else falls through to the generic pluralizer below.
const OVERRIDES: Record<string, string> = {
  Departamento: "Departments",
  "Federal District": "Federal Districts",
  District: "Districts",
  Canton: "Cantons",
  Emirate: "Emirates",
  Governorate: "Governorates",
  Municipality: "Municipalities",
  Territory: "Territories",
  County: "Counties",
};

function pluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

/** Most-common subdivision_type among a country's own child regions, pluralized for display.
 *  Falls back to "Provinces" when nothing's known yet (before drill-down, or an unrecognized/
 *  missing type). */
export function subdivisionLabelFor(childTypes: Array<string | null | undefined>): string {
  const counts = new Map<string, number>();
  for (const t of childTypes) {
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [type, count] of counts) {
    if (count > bestCount) {
      best = type;
      bestCount = count;
    }
  }
  if (!best) return "Provinces";
  return OVERRIDES[best] ?? pluralize(best);
}
