import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { yearsPhotographed } from "./statsHelpers";
import type {
  ArchiveHealthResponse,
  PhotoFilter,
  PhotographyDnaResponse,
  SpeciesPortfolioResponse,
  StatsResponse,
  YearComparisonResponse,
} from "./types";

// Everything the Stats page loads. The main stats follow the photo filter; the collection
// sections always cover the whole library. Each request is cancelled when it's superseded.
export function useStatsData(filter: PhotoFilter) {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [portfolio, setPortfolio] = useState<SpeciesPortfolioResponse | null>(null);
  const [archiveHealth, setArchiveHealth] = useState<ArchiveHealthResponse | null>(null);
  const [photographyDna, setPhotographyDna] = useState<PhotographyDnaResponse | null>(null);
  // null until the user picks a year; until then the comparison uses the two most recent.
  const [pickedYearA, setYearA] = useState<number | null>(null);
  const [pickedYearB, setYearB] = useState<number | null>(null);
  const [yearComparison, setYearComparison] = useState<YearComparisonResponse | null>(null);
  const [sectionError, setSectionError] = useState(false);
  // The request that failed, so a new filter or a retry starts without the old error.
  const statsRequest = `${filter}|${reloadKey}`;
  const [failedRequest, setFailedRequest] = useState<string | null>(null);
  const loadError = failedRequest === statsRequest ? "Couldn't load stats. Try again." : null;

  useEffect(() => {
    const controller = new AbortController();
    const request = `${filter}|${reloadKey}`;
    api
      .get<StatsResponse>(`/stats?filter=${filter}`, { signal: controller.signal })
      .then(setStats)
      .catch(() => {
        if (!controller.signal.aborted) setFailedRequest(request);
      });
    return () => controller.abort();
  }, [filter, reloadKey]);

  // Always over the whole library, not narrowed by the keeper filter.
  useEffect(() => {
    const controller = new AbortController();
    const opts = { signal: controller.signal };
    api
      .get<SpeciesPortfolioResponse>("/stats/species-portfolio", opts)
      .then(setPortfolio)
      .catch(() => {
        if (!controller.signal.aborted) setPortfolio({ species: [] });
      });
    api
      .get<ArchiveHealthResponse>("/stats/archive-health", opts)
      .then(setArchiveHealth)
      .catch(() => {
        if (!controller.signal.aborted) setSectionError(true);
      });
    api
      .get<PhotographyDnaResponse>("/stats/photography-dna", opts)
      .then(setPhotographyDna)
      .catch(() => {
        if (!controller.signal.aborted) setSectionError(true);
      });
    return () => controller.abort();
  }, []);

  // Years to compare come from the portfolio's photo dates; defaults to the two most recent.
  const availableYears = useMemo(() => yearsPhotographed(portfolio), [portfolio]);
  const yearA = pickedYearA ?? availableYears[0] ?? null;
  const yearB = pickedYearB ?? availableYears[1] ?? null;

  useEffect(() => {
    if (yearA === null || yearB === null) return;
    const controller = new AbortController();
    api
      .get<YearComparisonResponse>(`/stats/year-comparison?yearA=${yearA}&yearB=${yearB}`, {
        signal: controller.signal,
      })
      .then(setYearComparison)
      .catch(() => {
        if (!controller.signal.aborted) setSectionError(true);
      });
    return () => controller.abort();
  }, [yearA, yearB]);

  return {
    stats,
    loadError,
    retry: () => setReloadKey((k) => k + 1),
    sectionError,
    portfolio,
    archiveHealth,
    photographyDna,
    years: {
      available: availableYears,
      a: yearA,
      b: yearB,
      setA: setYearA,
      setB: setYearB,
      comparison: yearComparison,
    },
  };
}

export type StatsData = ReturnType<typeof useStatsData>;
