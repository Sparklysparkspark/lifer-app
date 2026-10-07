import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";

export interface NearbySeaZone {
  id: string;
  name: string;
  /** Species you added to this zone's checklist yourself. */
  addedByYou: number;
}

const NO_ZONES: NearbySeaZone[] = [];

// The sea zones offered as "nearby water" on a region's checklist. Fetched apart from the list
// itself because whether they're offered at all (and so whether the list asks for them) depends on
// them: a zone you added species to is offered even where its fish wouldn't be. `known` is false
// until this region's answer is in.
export function useNearbySeaZones(regionId: string | null, regionKnownHub: boolean) {
  const key = regionId && !regionKnownHub ? regionId : null;
  const [loaded, setLoaded] = useState<{ key: string; zones: NearbySeaZone[] } | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    api
      .get<{ zones: NearbySeaZone[] }>(`/regions/${key}/sea-zones`)
      .then((res) => {
        if (!cancelled) setLoaded({ key, zones: res.zones });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, zones: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [key, reloads]);

  const current = key && loaded?.key === key ? loaded.zones : null;
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  return { zones: current ?? NO_ZONES, known: !key || current !== null, reload };
}
