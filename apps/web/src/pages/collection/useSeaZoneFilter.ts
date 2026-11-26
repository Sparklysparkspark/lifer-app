import { useEffect } from "react";
import { SEA_ZONE_TAXA } from "@lifer/shared";
import { SEA_ZONES_NONE, type UpdateParams } from "./useCollectionUrlState";

// Sea zones add sea life only, so the control is pointless for a birds or amphibians filter, and
// confusing before the region's own pack for one of the filtered sea classes is installed.
export function seaZonesRelevantFor(
  taxonFilters: Set<string>,
  regionId: string | null,
  isTaxonPackDownloaded: (id: string | null, taxonClass: string) => boolean,
): boolean {
  const taxa = taxonFilters.size === 0 ? SEA_ZONE_TAXA : SEA_ZONE_TAXA.filter((t) => taxonFilters.has(t));
  return taxa.length > 0 && (!regionId || taxa.some((t) => isTaxonPackDownloaded(regionId, t)));
}

// Nearby water is ticked by default; only an explicit choice (including "none") overrides it.
export function effectiveSeaZoneIds(
  chosen: boolean,
  explicitIds: string[],
  zones: Array<{ id: string }>,
  seaZonesRelevant: boolean,
): string[] {
  return chosen || !seaZonesRelevant ? explicitIds : zones.map((z) => z.id);
}

export function useSeaZoneFilter({
  regionId,
  seaZonesRelevant,
  packsKnown,
  seaZoneIds,
  seaZones,
  updateParams,
}: {
  regionId: string | null;
  seaZonesRelevant: boolean;
  // Pack gating is unknown until the pack index arrives.
  packsKnown: boolean;
  seaZoneIds: string[];
  seaZones: Array<{ id: string; name: string }>;
  updateParams: UpdateParams;
}) {
  // Hidden checkboxes shouldn't keep filtering from the URL and jump back later. Waits for the
  // pack index so a restored ?seaZones= isn't wiped before relevance is known.
  useEffect(() => {
    if (regionId && !packsKnown) return;
    if (!seaZonesRelevant && seaZoneIds.length > 0) updateParams({ seaZones: null, includeLand: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change in relevance clears them; a region change already does
  }, [seaZonesRelevant, packsKnown]);

  // A zone id this region doesn't offer (an old link) filters with no checkbox to untick it.
  useEffect(() => {
    if (!packsKnown || seaZoneIds.length === 0) return;
    const offered = seaZoneIds.filter((id) => seaZones.some((z) => z.id === id));
    if (offered.length < seaZoneIds.length)
      updateParams(
        { seaZones: offered.join(",") || null, ...(offered.length === 0 ? { includeLand: null } : {}) },
        { replace: true },
      );
  }, [packsKnown, seaZoneIds, seaZones, updateParams]);

  function toggleSeaZone(zoneId: string, checked: boolean) {
    const next = checked ? [...seaZoneIds, zoneId] : seaZoneIds.filter((id) => id !== zoneId);
    // "Include land" means nothing without a zone, so it goes with the last one.
    updateParams({
      seaZones: next.length > 0 ? next.join(",") : SEA_ZONES_NONE,
      ...(next.length === 0 ? { includeLand: null } : {}),
    });
  }

  function setAllSeaZones(checked: boolean) {
    updateParams({
      seaZones: checked ? seaZones.map((z) => z.id).join(",") : SEA_ZONES_NONE,
      ...(checked ? {} : { includeLand: null }),
    });
  }

  function setIncludeLand(checked: boolean) {
    updateParams({ includeLand: checked ? null : "0" });
  }

  return { toggleSeaZone, setAllSeaZones, setIncludeLand };
}
