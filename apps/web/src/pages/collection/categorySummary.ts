import type { CollectionItem } from "@lifer/shared";
import { TIER_ORDER } from "../../lib/speciesGroups";

export interface CategorySummary {
  taxon: string;
  collected: number;
  total: number;
  /** Your photo for the card, else a reference photo shown greyed. */
  cover: CollectionItem | null;
  own: boolean;
}

// Rarest first (legendary 0); unknown last.
const rarity = (item: CollectionItem) => {
  const i = TIER_ORDER.indexOf(item.localTier ?? item.tier ?? "unrated");
  return i < 0 ? TIER_ORDER.length : i;
};
// For the stand-in picture: common species first, unrated ones after the named tiers.
const commonness = (item: CollectionItem) => {
  const i = TIER_ORDER.indexOf(item.localTier ?? item.tier ?? "unrated");
  return i < 0 || TIER_ORDER[i] === "unrated" ? -1 : i;
};
const isOwnCover = (item: CollectionItem) =>
  item.state === "collected" && !!item.coverPhotoUrl?.startsWith("/api/photos/");

/** One summary per offered animal group with species in the list. The cover is your rarest
 *  photographed species (most photos breaking ties), else the group's most common species with a
 *  reference photo, so the stand-in picture is an iconic one. */
export function summarizeCategories(items: CollectionItem[], taxa: string[]): CategorySummary[] {
  const byTaxon = new Map<string, CollectionItem[]>();
  for (const item of items) {
    const key = item.taxonClass?.toLowerCase();
    if (!key) continue;
    const list = byTaxon.get(key);
    if (list) list.push(item);
    else byTaxon.set(key, [item]);
  }
  return taxa.flatMap((taxon) => {
    const list = byTaxon.get(taxon);
    if (!list) return [];
    let collected = 0;
    let best: CollectionItem | null = null;
    let reference: CollectionItem | null = null;
    for (const item of list) {
      if (item.state === "collected") collected++;
      if (isOwnCover(item)) {
        if (
          !best ||
          rarity(item) < rarity(best) ||
          (rarity(item) === rarity(best) && (item.photoCount ?? 0) > (best.photoCount ?? 0))
        )
          best = item;
      } else if (item.coverPhotoUrl && (!reference || commonness(item) > commonness(reference))) reference = item;
    }
    return [{ taxon, collected, total: list.length, cover: best ?? reference, own: !!best }];
  });
}
