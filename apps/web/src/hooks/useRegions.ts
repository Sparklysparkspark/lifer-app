import type { RegionSummary } from "@lifer/shared";
import { createCachedRoute } from "../lib/resource";

// One cached GET /regions (the full region tree without boundaries) for the whole app.
const regionsResource = createCachedRoute("/regions", (res): RegionSummary[] => res.regions);

export const refreshRegions = regionsResource.refresh;
export const loadRegions = regionsResource.load;

export function useRegions(): {
  regions: RegionSummary[] | null;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<RegionSummary[]>;
} {
  const { data, loading, error, refresh } = regionsResource.use();
  return { regions: data, loading, error, refresh };
}
