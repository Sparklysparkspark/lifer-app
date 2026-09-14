import { useEffect, useState } from "react";
import { checkPmtilesAvailable } from "../lib/pmtiles";

// Whether the offline world basemap has been downloaded — null while the check is still in
// flight, then true/false. Was duplicated (its own useState + useEffect pair, identically)
// across PacksMap.tsx, RegionMap.tsx, and SpeciesHotspotMap.tsx; pulled out once rather than
// kept in sync by hand across three call sites.
export function useMapAvailable(): boolean | null {
  const [mapAvailable, setMapAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    checkPmtilesAvailable().then(setMapAvailable);
  }, []);
  return mapAvailable;
}
