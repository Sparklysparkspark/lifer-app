import { useEffect, useState } from "react";
import { checkPmtilesAvailable } from "../lib/pmtilesAvailable";

// Whether the offline world basemap is downloaded: null while checking, then true/false.
export function useMapAvailable(): boolean | null {
  const [mapAvailable, setMapAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    checkPmtilesAvailable().then((ok) => {
      if (!cancelled) setMapAvailable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return mapAvailable;
}
