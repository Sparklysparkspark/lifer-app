import { useCallback, useEffect, useRef, useState } from "react";
import type { RegionSummary } from "@lifer/shared";

/** Whether the desktop app's first run should start onboarding: no pack at all, known for sure.
 *  A pack list that failed to load, or a download still putting its first pack in, isn't a first
 *  run (onboarding sends a running download back here). `downloadRunning` is null until known. */
export function startsOnboarding(o: {
  desktop: boolean;
  packCount: number | null;
  packsError: boolean;
  downloadRunning: boolean | null;
}): boolean {
  return o.desktop && o.packCount === 0 && !o.packsError && o.downloadRunning === false;
}

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
  setRegionParam: (id: string | null, options?: { replace?: boolean }) => void;
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
    // Replaces the bare page: as its own history entry, Back would land on it and bounce forward.
    setRegionParam(decision.restore, { replace: true });
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

  // A restored region whose country's download was since removed falls back to a country that's
  // still downloaded (same continent first), else its continent. Only for the restore: a region
  // browsed to on purpose keeps its download prompt.
  const checkedRestore = useRef(false);
  useEffect(() => {
    if (checkedRestore.current || !decision.restore || regionId !== decision.restore) return;
    if (!regionsLoaded || !downloadedCountryNames) return;
    checkedRestore.current = true;
    const fallbackId = restoreFallback(decision.restore, allRegions, downloadedCountryNames);
    if (fallbackId) setRegionParam(fallbackId, { replace: true });
  }, [decision.restore, regionId, regionsLoaded, downloadedCountryNames, allRegions, setRegionParam]);

  // With exactly one downloaded country and no region chosen, go straight into it. Stops applying
  // on its own once a second country is downloaded.
  const onlyName = downloadedCountryNames?.size === 1 ? [...downloadedCountryNames][0] : null;
  const autoRegionId =
    regionResolved && !regionId && onlyName ? (allRegions.find((r) => r.name === onlyName)?.id ?? null) : null;
  if (autoRegionId && firstRunPrompt) setFirstRunPrompt(false);
  useEffect(() => {
    if (autoRegionId) setRegionParam(autoRegionId, { replace: true });
  }, [autoRegionId, setRegionParam]);

  return { firstRunPrompt, regionResolved, navigateToRegion };
}

/** Where a restored region should go instead when its country is no longer downloaded, or null to
 *  keep it. Hubs (World, continents) always stay. */
export function restoreFallback(
  regionId: string,
  allRegions: RegionSummary[],
  downloadedCountryNames: Set<string>,
): string | null {
  const byId = new Map(allRegions.map((r) => [r.id, r]));
  const start = byId.get(regionId);
  if (!start) return null;
  const chain: RegionSummary[] = [];
  for (let r: RegionSummary | undefined = start; r; r = r.parentId ? byId.get(r.parentId) : undefined) chain.push(r);
  if (!start.hasScopedChecklist || chain.some((r) => downloadedCountryNames.has(r.name))) return null;
  const continent = chain.find((r) => r !== start && !r.hasScopedChecklist) ?? null;
  const downloaded = allRegions
    .filter((r) => downloadedCountryNames.has(r.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sameContinent = continent ? downloaded.find((r) => r.parentId === continent.id) : undefined;
  return (sameContinent ?? downloaded[0] ?? continent)?.id ?? null;
}
