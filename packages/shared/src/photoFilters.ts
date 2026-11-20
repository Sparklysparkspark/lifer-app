// Gallery filters that take several values: a photo matches any one of a filter's values (OR),
// and every filter that is set must match (AND). Smart album rules and the Gallery's URL both
// carry each of these as a list.
export const MULTI_VALUE_FILTERS = ["regionId", "tag", "place", "tripId", "albumId", "tier"] as const;
export type MultiValueFilter = (typeof MULTI_VALUE_FILTERS)[number];

/** A smart album rule query written before filters took lists (rules version 1), as the lists
 *  version 2 holds: each single value becomes a one-value list. Other keys pass through. */
export function upgradeRulesQuery(query: object): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  for (const key of MULTI_VALUE_FILTERS) {
    const value = out[key];
    if (typeof value === "string") out[key] = value ? [value] : [];
  }
  return out;
}
