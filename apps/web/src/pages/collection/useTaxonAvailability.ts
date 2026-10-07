import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { TAXON_LABEL, type TaxonFilter } from "./taxonLabels";

// Which taxon filters to offer: downloaded and present in the current region, plus any taxon the
// user has photographed there, so imported species stay findable. A selected value always stays offered.
export function useTaxonAvailability({
  regionId,
  regionKnownHub,
  taxonFilters,
  isTaxonPackDownloaded,
  downloadedRegionTaxons,
}: {
  regionId: string | null;
  regionKnownHub: boolean;
  taxonFilters: Set<string>;
  isTaxonPackDownloaded: (id: string | null, taxonClass: string) => boolean;
  downloadedRegionTaxons: Map<string, Set<string | null>> | null;
}) {
  // Taxon classes with any species in this region's checklist. null means "don't restrict".
  const [taxaPresentForRegion, setTaxaPresentForRegion] = useState<Set<string> | null>(null);
  // Taxa photographed in the region or anywhere inside it (hubs included).
  const [photographedTaxa, setPhotographedTaxa] = useState<Set<string>>(new Set());
  // Without a region (or for a hub) there's nothing to ask the server, so these are cleared.
  const clearUnfetched = useCallback(() => {
    if (!regionId) setPhotographedTaxa(new Set());
    if (!regionId || regionKnownHub) setTaxaPresentForRegion(null);
  }, [regionId, regionKnownHub]);

  const generation = useRef(0);
  const fetchTaxaPresent = useCallback(() => {
    const current = ++generation.current;
    if (regionId) {
      api
        .get<{ taxa: string[] }>(`/regions/${regionId}/photographed-taxa`)
        .then((res) => {
          if (current === generation.current) setPhotographedTaxa(new Set(res.taxa));
        })
        .catch(() => {
          if (current === generation.current) setPhotographedTaxa(new Set());
        });
    }
    if (!regionId || regionKnownHub) return;
    api
      .get<Record<string, string[]>>(`/regions/taxon-presence?regionIds=${regionId}`)
      .then((res) => {
        if (current === generation.current) setTaxaPresentForRegion(new Set(res[regionId] ?? []));
      })
      .catch(() => {
        if (current === generation.current) setTaxaPresentForRegion(null);
      });
  }, [regionId, regionKnownHub]);

  const reloadTaxaPresent = useCallback(() => {
    clearUnfetched();
    fetchTaxaPresent();
  }, [clearUnfetched, fetchTaxaPresent]);

  // A new region clears in the same render rather than from the effect after it.
  const regionKey = JSON.stringify([regionId, regionKnownHub]);
  const [clearedFor, setClearedFor] = useState<string | null>(null);
  if (clearedFor !== regionKey) {
    setClearedFor(regionKey);
    clearUnfetched();
  }
  useEffect(fetchTaxaPresent, [fetchTaxaPresent]);

  const taxaDownloadedAnywhere = useMemo(() => {
    const set = new Set<string>();
    for (const taxons of downloadedRegionTaxons?.values() ?? []) {
      for (const t of taxons) if (t) set.add(t);
    }
    return set;
  }, [downloadedRegionTaxons]);

  // Specific Other Taxa groups (e.g. "insecta") come back from the same presence query. They
  // have no pack, so they're only offered with a region selected, and always when present.
  const otherTaxaIconicFiltersPresent = useMemo(() => {
    if (!regionId || !taxaPresentForRegion) return [];
    return [...taxaPresentForRegion].filter((t) => !(t in TAXON_LABEL));
  }, [regionId, taxaPresentForRegion]);

  const availableTaxonFilters = useMemo(
    () =>
      [
        ...(Object.keys(TAXON_LABEL) as TaxonFilter[]).filter((t) => t !== "all" && t !== "other-taxa"),
        ...otherTaxaIconicFiltersPresent,
        ...taxonFilters,
      ]
        .filter((t, i, arr) => arr.indexOf(t) === i)
        .filter((t) => {
          if (taxonFilters.has(t) || otherTaxaIconicFiltersPresent.includes(t) || photographedTaxa.has(t)) return true;
          if (regionId)
            return isTaxonPackDownloaded(regionId, t) && (!taxaPresentForRegion || taxaPresentForRegion.has(t));
          return taxaDownloadedAnywhere.has(t);
        }),
    [
      regionId,
      taxonFilters,
      isTaxonPackDownloaded,
      taxaPresentForRegion,
      taxaDownloadedAnywhere,
      otherTaxaIconicFiltersPresent,
      photographedTaxa,
    ],
  );

  return { availableTaxonFilters, reloadTaxaPresent };
}
