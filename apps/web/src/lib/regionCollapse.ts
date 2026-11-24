import type { RegionSummary } from "@lifer/shared";
import { groupInto } from "./groupInto";
import { normalizeForSearch } from "./searchNormalize";

/** One place listed twice shows once. Below country level, a region with exactly one available
 *  child area (a familiar group holding a single province) lists under its own name but opens the
 *  child, and trails show that name once. A country whose only available area has the country's
 *  name (Aruba in Aruba) is the country itself: that area is never listed, outlined or put in a
 *  trail, and opening it opens the country, which keeps its downloads and checklist. Hubs never
 *  collapse. `availableRegionIds` null counts every child. */
export function regionCollapse(regions: RegionSummary[], availableRegionIds: Set<string> | null) {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const childrenOf = new Map<string, RegionSummary[]>();
  for (const r of regions) {
    if (r.parentId != null && (!availableRegionIds || availableRegionIds.has(r.id)))
      groupInto(childrenOf, r.parentId, r);
  }
  const soleChild = (r: RegionSummary | undefined): RegionSummary | undefined => {
    const parent = r?.parentId ? byId.get(r.parentId) : undefined;
    const kids = r ? childrenOf.get(r.id) : undefined;
    return r?.hasScopedChecklist && parent?.hasScopedChecklist && kids?.length === 1 ? kids[0] : undefined;
  };
  /** A country's lone area under the country's own name (accents, case and punctuation aside). */
  const twinOf = (r: RegionSummary | undefined): RegionSummary | undefined => {
    const parent = r?.parentId ? byId.get(r.parentId) : undefined;
    const kids = r ? childrenOf.get(r.id) : undefined;
    return r?.hasScopedChecklist &&
      parent &&
      !parent.hasScopedChecklist &&
      kids?.length === 1 &&
      normalizeForSearch(kids[0].name) === normalizeForSearch(r.name)
      ? kids[0]
      : undefined;
  };
  const isTwin = (r: RegionSummary | undefined) => !!r?.parentId && twinOf(byId.get(r.parentId)) === r;
  /** The region `id` is shown as: its country for a country's twin, else itself. */
  const shownAs = (id: string): string => {
    const r = byId.get(id);
    return isTwin(r) ? r!.parentId! : id;
  };
  /** Where opening `id` lands: down through every collapsed level. */
  const target = (id: string): string => {
    let r = byId.get(shownAs(id));
    for (let c = soleChild(r); c; c = soleChild(c)) r = c;
    return r?.id ?? id;
  };
  return {
    target,
    shownAs,
    /** The areas to list for `id`: its landing region's children (a twin's, for its country),
     *  each opening its own landing. */
    areasOf: (id: string): RegionSummary[] => {
      const landing = target(id);
      const home = twinOf(byId.get(landing))?.id ?? landing;
      return (childrenOf.get(home) ?? []).map((c) => ({ ...c, id: target(c.id) }));
    },
    /** World down to `id`, each collapsed region standing in (by name, opening its landing) for
     *  the levels it hides; a twin is left out. */
    trail: (id: string | null): RegionSummary[] => {
      const trail: RegionSummary[] = [];
      for (let r = id ? byId.get(shownAs(id)) : undefined; r; r = r.parentId ? byId.get(r.parentId) : undefined) {
        if (isTwin(r)) continue;
        if (soleChild(r) && trail.length) trail.shift();
        trail.unshift(soleChild(r) ? { ...r, id: target(r.id) } : r);
      }
      return trail;
    },
  };
}
