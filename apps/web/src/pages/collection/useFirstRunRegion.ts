import { useCallback, useEffect, useRef, useState } from "react";
import type { RegionSummary } from "@lifer/shared";

// With no ?region=, restore the last region viewed. A first visit shows a download prompt; with
// exactly one downloaded country, jump straight into it.
export function useFirstRunRegion({
  regionId,
  setRegionParam,
  regionsLoaded,
  allRegions,
  downloadedCountryNames,
}: {
  regionId: string | null;
  setRegionParam: (id: string | null) => void;
  regionsLoaded: boolean;
  allRegions: RegionSummary[];
  downloadedCountryNames: Set<string> | null;
}) {
  const restored = useRef(false);
  const [firstRunPrompt, setFirstRunPrompt] = useState(false);
  const [pendingFirstRunDecision, setPendingFirstRunDecision] = useState(false);
  // Gates the first fetch until the restore decision has been made.
  const [regionResolved, setRegionResolved] = useState(false);

  const navigateToRegion = useCallback(
    (id: string | null) => {
      setFirstRunPrompt(false);
      setRegionParam(id);
    },
    [setRegionParam],
  );

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (regionId) {
      setRegionResolved(true);
      return;
    }
    try {
      const lastRegionId = localStorage.getItem("lifer:lastRegionId");
      if (lastRegionId) {
        setRegionParam(lastRegionId);
        setRegionResolved(true);
        return;
      }
    } catch {
      // Storage disabled: fall through to the first-run decision.
    }
    setPendingFirstRunDecision(true);
    setRegionResolved(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!regionId) return;
    try {
      localStorage.setItem("lifer:lastRegionId", regionId);
    } catch {
      // Losing this preference is harmless.
    }
  }, [regionId]);

  useEffect(() => {
    if (!pendingFirstRunDecision || !regionsLoaded) return;
    setPendingFirstRunDecision(false);
    setFirstRunPrompt(true);
  }, [pendingFirstRunDecision, regionsLoaded]);

  // Stops applying on its own once a second country is downloaded.
  useEffect(() => {
    if (!regionResolved || regionId || !downloadedCountryNames || downloadedCountryNames.size !== 1) return;
    const onlyName = [...downloadedCountryNames][0];
    const onlyCountry = allRegions.find((r) => r.name === onlyName);
    if (onlyCountry) navigateToRegion(onlyCountry.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionResolved, regionId, downloadedCountryNames, allRegions]);

  return { firstRunPrompt, regionResolved, navigateToRegion };
}
