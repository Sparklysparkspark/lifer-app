import { useEffect, useState } from "react";
import { api, apiPath } from "../../api/client";
import { ignore } from "../../lib/ignore";
import { galleryParams } from "./galleryHelpers";
import type { GalleryQuery } from "./types";

/** The filters a loaded album or trip photo can't answer itself (matchesPhotoFilters does the rest). */
export function needsServerFilter(q: GalleryQuery): boolean {
  return (
    q.selectedTaxa.size > 0 ||
    q.tiers.length > 0 ||
    q.shotActions.size > 0 ||
    q.shotFramings.size > 0 ||
    q.regionIds.length > 0 ||
    q.places.length > 0 ||
    Object.values(q.appearance).some((values) => values.length > 0) ||
    q.tags.length > 0 ||
    q.animalsMin !== null ||
    q.animalsMax !== null ||
    q.onlyFeatured ||
    q.notOnInat ||
    q.missingCoordinates ||
    q.onlyHidden
  );
}

export type FilterScope = { albumId: string } | { tripId: string };

// The capture ids in an album or trip that the Gallery's filters match, from the Gallery's own
// query. Null when the page's own matching is enough; the last answer stays while a new one loads.
export function useScopedFilterIds(scope: FilterScope | null, query: GalleryQuery): Set<string> | null {
  let key: string | null = null;
  if (scope && needsServerFilter(query)) {
    const params = galleryParams({ ...query, searchQuery: "", scopeTripId: null, scopeAlbumId: null });
    for (const [name, value] of Object.entries(scope)) params.set(name, value);
    key = params.toString();
  }
  const [result, setResult] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    api
      .get(apiPath("/gallery/ids", {}, new URLSearchParams(key)), { signal: controller.signal })
      .then((res) => setResult(new Set(res.captureIds)))
      .catch(ignore("Couldn't filter the photos"));
    return () => controller.abort();
  }, [key]);
  return key ? result : null;
}
