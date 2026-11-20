import { useMemo, useState } from "react";
import { apiPath } from "../../api/client";
import { useApiResource, useApiRoute } from "../../lib/resource";
import { yearsPhotographed } from "./statsHelpers";
import type {
  ArchiveHealthResponse,
  PhotoFilter,
  PhotographyDnaResponse,
  SpeciesPortfolioResponse,
  StatsResponse,
  YearComparisonResponse,
} from "./types";

const EMPTY_PORTFOLIO: SpeciesPortfolioResponse = { species: [] };

// Everything the Stats page loads. The main stats follow the photo filter; the collection
// sections always cover the whole library. Each request is cancelled when it's superseded, and
// a page opened again starts from the last answers while it refetches (useApiResource).
export function useStatsData(filter: PhotoFilter, includeRaw = true) {
  const main = useApiResource<StatsResponse>(
    apiPath("/stats", {}, { filter, ...(includeRaw ? {} : { includeRaw: "0" as const }) }),
  );
  // A new filter keeps the last stats up until its own answer lands.
  const [lastStats, setLastStats] = useState<StatsResponse | null>(main.data);
  if (main.data && main.data !== lastStats) setLastStats(main.data);
  const stats = main.data ?? lastStats;
  // What the last load threw; the page words it (EmptyState, connectionMessage).
  const loadError: unknown = main.error;

  // Always over the whole library, not narrowed by the keeper filter.
  const portfolioRes = useApiResource<SpeciesPortfolioResponse>("/stats/species-portfolio");
  const portfolio = portfolioRes.data ?? (portfolioRes.error ? EMPTY_PORTFOLIO : null);
  const archiveHealth = useApiResource<ArchiveHealthResponse>("/stats/archive-health");
  const photographyDna = useApiResource<PhotographyDnaResponse>("/stats/photography-dna");

  // null until the user picks a year; until then the comparison uses the two most recent.
  const [pickedYearA, setYearA] = useState<number | null>(null);
  const [pickedYearB, setYearB] = useState<number | null>(null);
  // Years to compare come from the portfolio's photo dates; defaults to the two most recent.
  const availableYears = useMemo(() => yearsPhotographed(portfolio), [portfolio]);
  const yearA = pickedYearA ?? availableYears[0] ?? null;
  const yearB = pickedYearB ?? availableYears[1] ?? null;
  const yearComparison = useApiRoute(
    yearA !== null && yearB !== null ? apiPath("/stats/year-comparison", {}, { yearA, yearB }) : null,
  );

  return {
    stats,
    loadError,
    retry: () => void main.reload(),
    sectionError: !!(archiveHealth.error || photographyDna.error || yearComparison.error),
    portfolio,
    archiveHealth: archiveHealth.data,
    photographyDna: photographyDna.data,
    years: {
      available: availableYears,
      a: yearA,
      b: yearB,
      setA: setYearA,
      setB: setYearB,
      comparison: yearComparison.data as YearComparisonResponse | null,
    },
  };
}

export type StatsData = ReturnType<typeof useStatsData>;
