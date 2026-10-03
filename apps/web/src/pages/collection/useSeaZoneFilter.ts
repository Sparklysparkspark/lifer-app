import { useEffect, useRef } from "react";
import { api } from "../../api/client";
import type { UpdateParams } from "./useCollectionUrlState";

// Sea zones only add fish, so the control is pointless for a birds/mammals filter, and
// confusing before the region's own fish pack is installed.
export function seaZonesRelevantFor(
  taxonFilters: Set<string>,
  regionId: string | null,
  isTaxonPackDownloaded: (id: string | null, taxonClass: string) => boolean,
): boolean {
  return (taxonFilters.size === 0 || taxonFilters.has("actinopterygii")) && (!regionId || isTaxonPackDownloaded(regionId, "actinopterygii"));
}

export function useSeaZoneFilter({
  regionId,
  regionKnownHub,
  seaZonesRelevant,
  packsKnown,
  seaZoneIds,
  seaZones,
  isTaxonPackDownloaded,
  updateParams,
}: {
  regionId: string | null;
  regionKnownHub: boolean;
  seaZonesRelevant: boolean;
  // Pack gating is unknown until the pack index arrives.
  packsKnown: boolean;
  seaZoneIds: string[];
  seaZones: Array<{ id: string; name: string }>;
  isTaxonPackDownloaded: (id: string | null, taxonClass: string) => boolean;
  updateParams: UpdateParams;
}) {
  // Hidden checkboxes shouldn't keep filtering from the URL and jump back later. Waits for the
  // pack index so a restored ?seaZones= isn't wiped before relevance is known.
  useEffect(() => {
    if (regionId && !packsKnown) return;
    if (!seaZonesRelevant && seaZoneIds.length > 0) updateParams({ seaZones: null, includeLand: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seaZonesRelevant, packsKnown]);

  // A region with no native fish but nearby marine zones checks its zones automatically, once per
  // region (tracked in a ref so a manual uncheck isn't re-applied).
  const autoSelected = useRef(new Set<string>());
  // The count can land after the user has moved on, and must not set this region's zones on the next.
  const currentRegionId = useRef(regionId);
  currentRegionId.current = regionId;
  useEffect(() => {
    if (!regionId || regionKnownHub || !seaZonesRelevant) return;
    if (seaZones.length === 0 || seaZoneIds.length > 0) return;
    if (autoSelected.current.has(regionId)) return;
    // With the fish pack missing, 0 fish means "not downloaded", not "none here".
    if (!isTaxonPackDownloaded(regionId, "actinopterygii")) return;
    autoSelected.current.add(regionId);
    api
      .get<{ total: number }>(`/regions/${regionId}/species/count?taxon=actinopterygii`)
      .then((res) => {
        if (res.total === 0 && currentRegionId.current === regionId) updateParams({ seaZones: seaZones.map((z) => z.id).join(",") });
      })
      .catch(() => {
        // Let the next render retry instead of treating a failed check as "has fish".
        autoSelected.current.delete(regionId);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionId, regionKnownHub, seaZonesRelevant, seaZones, seaZoneIds.length, isTaxonPackDownloaded]);

  function toggleSeaZone(zoneId: string, checked: boolean) {
    const next = checked ? [...seaZoneIds, zoneId] : seaZoneIds.filter((id) => id !== zoneId);
    // "Include land" means nothing without a zone, so it goes with the last one.
    updateParams({
      seaZones: next.length > 0 ? next.join(",") : null,
      ...(next.length === 0 ? { includeLand: null } : {}),
    });
  }

  function setAllSeaZones(checked: boolean) {
    updateParams({
      seaZones: checked ? seaZones.map((z) => z.id).join(",") : null,
      ...(checked ? {} : { includeLand: null }),
    });
  }

  function setIncludeLand(checked: boolean) {
    updateParams({ includeLand: checked ? null : "0" });
  }

  return { toggleSeaZone, setAllSeaZones, setIncludeLand };
}
