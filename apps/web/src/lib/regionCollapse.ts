import type { RegionSummary } from "@lifer/shared";
import { groupInto } from "./groupInto";

/** Below country level, a region with exactly one available child area (a familiar group holding a
 *  single province) is one place listed twice. Lists show it under its own name but open the child,
 *  and trails show that name once. Hubs and countries never collapse. `availableRegionIds` null
 *  counts every child. */
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
  /** Where opening `id` lands: down through every collapsed level. */
  const target = (id: string): string => {
    let r = byId.get(id);
    for (let c = soleChild(r); c; c = soleChild(c)) r = c;
    return r?.id ?? id;
  };
  return {
    target,
    /** The areas to list for `id`: its landing region's children, each opening its own landing. */
    areasOf: (id: string): RegionSummary[] =>
      (childrenOf.get(target(id)) ?? []).map((c) => ({ ...c, id: target(c.id) })),
    /** World down to `id`, each collapsed region standing in (by name, opening its landing) for
     *  the levels it hides. */
    trail: (id: string | null): RegionSummary[] => {
      const trail: RegionSummary[] = [];
      for (let r = id ? byId.get(id) : undefined; r; r = r.parentId ? byId.get(r.parentId) : undefined) {
        if (soleChild(r) && trail.length) trail.shift();
        trail.unshift(soleChild(r) ? { ...r, id: target(r.id) } : r);
      }
      return trail;
    },
  };
}
