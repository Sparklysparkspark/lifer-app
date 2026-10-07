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
  // Decided once, from the URL and storage as the page first renders: restore a stored region,
  // or (with none) wait for the region list and then show the first-run prompt.
  const [decision] = useState<{ restore: string | null; pending: boolean }>(() => {
    if (regionId) return { restore: null, pending: false };
    try {
      const lastRegionId = localStorage.getItem("lifer:lastRegionId");
      if (lastRegionId) return { restore: lastRegionId, pending: false };
    } catch {
      // Storage disabled: fall through to the first-run decision.
    }
    return { restore: null, pending: true };
  });
  const [firstRunPrompt, setFirstRunPrompt] = useState(false);
  const [pendingFirstRunDecision, setPendingFirstRunDecision] = useState(decision.pending);
  // Gates the first fetch until the restored region is in the URL, so the page doesn't load the
  // whole collection first. Latched: leaving the region later doesn't un-resolve it.
  const [regionResolved, setRegionResolved] = useState(false);
  if (!regionResolved && (decision.restore === null || regionId)) setRegionResolved(true);

  const navigateToRegion = useCallback(
    (id: string | null) => {
      setFirstRunPrompt(false);
      setRegionParam(id);
    },
    [setRegionParam],
  );

  // setRegionParam writes the URL, so it runs after render. Latched to once: a new setRegionParam
  // (it changes with the URL) mustn't send the user back to the stored region.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !decision.restore) return;
    restored.current = true;
    setRegionParam(decision.restore);
  }, [decision.restore, setRegionParam]);

  useEffect(() => {
    if (!regionId) return;
    try {
      localStorage.setItem("lifer:lastRegionId", regionId);
    } catch {
      // Losing this preference is harmless.
    }
  }, [regionId]);

  if (pendingFirstRunDecision && regionsLoaded) {
    setPendingFirstRunDecision(false);
    setFirstRunPrompt(true);
  }

  // With exactly one downloaded country and no region chosen, go straight into it. Stops applying
  // on its own once a second country is downloaded.
  const onlyName = downloadedCountryNames?.size === 1 ? [...downloadedCountryNames][0] : null;
  const autoRegionId =
    regionResolved && !regionId && onlyName ? (allRegions.find((r) => r.name === onlyName)?.id ?? null) : null;
  if (autoRegionId && firstRunPrompt) setFirstRunPrompt(false);
  useEffect(() => {
    if (autoRegionId) setRegionParam(autoRegionId);
  }, [autoRegionId, setRegionParam]);

  return { firstRunPrompt, regionResolved, navigateToRegion };
}
