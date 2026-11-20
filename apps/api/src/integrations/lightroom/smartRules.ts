// Lightroom smart collection rules to a Lifer smart album's Gallery filters, where they map.
// Lifer's filters are all ANDed, so only a collection whose rules all must match can be taken.
import type { LuaValue } from "./luaTable.js";

export interface MappedRules {
  version: 2;
  query: { ratingMin?: string; ratingMax?: string; dateFrom?: string; dateTo?: string; tag?: string[] };
}

type Obj = { [key: string]: LuaValue };
const isObj = (v: LuaValue | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asList = (v: LuaValue | undefined): LuaValue[] => {
  if (Array.isArray(v)) return v;
  return isObj(v)
    ? Object.keys(v)
        .filter((k) => /^\d+$/.test(k))
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => v[k])
    : [];
};
const star = (n: number) => String(Math.min(5, Math.max(1, Math.round(n))));
const day = (v: LuaValue) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** The rules as Lifer filters, or why they can't be (and the collection is reported, not guessed at). */
export function mapSmartRules(parsed: LuaValue): { rules: MappedRules } | { reason: string } {
  if (!isObj(parsed)) return { reason: "The rules are in a form Lifer doesn't read" };
  if (parsed.combine !== undefined && parsed.combine !== "intersect")
    return { reason: "It matches photos that meet any one rule; Lifer's filters need all of them" };
  const query: MappedRules["query"] = {};
  const rules = asList(parsed.rules);
  if (rules.length === 0) return { reason: "It has no rules" };
  for (const rule of rules) {
    if (!isObj(rule)) return { reason: "A rule is in a form Lifer doesn't read" };
    const { criteria, operation, value } = rule;
    if (criteria === "rating" && typeof value === "number") {
      if (operation === ">=" || operation === ">") query.ratingMin = star(operation === ">" ? value + 1 : value);
      else if (operation === "<=" || operation === "<") query.ratingMax = star(operation === "<" ? value - 1 : value);
      else if (operation === "==") query.ratingMin = query.ratingMax = star(value);
      else return { reason: `Rating rule "${String(operation)}" has no Lifer match` };
    } else if (criteria === "captureTime") {
      const from = day(value);
      const to = day(rule.value2 ?? null);
      if (operation === ">" || operation === ">=" || operation === "after") {
        if (!from) return { reason: "A date rule has a date Lifer can't read" };
        query.dateFrom = from;
      } else if (operation === "<" || operation === "<=" || operation === "before") {
        if (!from) return { reason: "A date rule has a date Lifer can't read" };
        query.dateTo = from;
      } else if (operation === "in" && from && to) {
        query.dateFrom = from;
        query.dateTo = to;
      } else return { reason: "A date rule has no Lifer match" };
    } else if (
      criteria === "keywords" &&
      typeof value === "string" &&
      value.trim() &&
      (operation === "any" || operation === "==" || operation === "all")
    ) {
      // Several tag values would be read as "any of", not "all of", so only one is taken.
      if (query.tag) return { reason: "It needs several keywords at once, which Lifer's tag filter can't express" };
      query.tag = [value.trim()];
    } else return { reason: `The "${String(criteria)}" rule has no Lifer match` };
  }
  return { rules: { version: 2, query } };
}
