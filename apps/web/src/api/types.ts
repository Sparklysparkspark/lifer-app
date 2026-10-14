// Web-side names for API shapes, from the generated route types (schema.gen.ts).
import type { CollectionItem } from "@lifer/shared";

/** A species card as a route sends it. An added other taxon carries iNaturalist's iconic taxon as
 *  its taxonClass, a value @lifer/shared's TaxonClass doesn't list; every other field must match
 *  CollectionItem, which this checks. */
type ApiCollectionItem = Omit<CollectionItem, "taxonClass"> & { taxonClass: string | null };

export function toCollectionItems(items: ApiCollectionItem[]): CollectionItem[] {
  return items as CollectionItem[];
}
