import { useEffect } from "react";
import { createCachedRoute } from "../lib/resource";
import { ignore } from "../lib/ignore";

// Regions you have photos in, with the regions above them.
const regionsWithPhotos = createCachedRoute("/gallery/regions-with-photos", (res) => new Set(res.regionIds));

/** Fetched again on mount, so a new import's places show the next time a page opens. */
export function useRegionsWithPhotos(): Set<string> | null {
  const { data, refresh } = regionsWithPhotos.use(false);
  useEffect(() => {
    refresh().catch(ignore("Couldn't load the regions with photos"));
  }, [refresh]);
  return data;
}
