// A continent or the world has no outline of its own, so its map shows the downloaded countries
// in it instead: their outlines joined into one shape for RegionMap.
import { useMemo } from "react";
import type { RegionSummary } from "@lifer/shared";
import type { CountryBoundary } from "../../components/PacksMap";
import { countryBoundariesResource } from "../../lib/countryBoundaries";
import { continentIdForCountry } from "../../lib/regionGrouping";
import type { HubCountry } from "../../lib/mapCamera";

type Polygons = unknown[];

/** The outlines as one MultiPolygon feature, or null when none has one. */
export function joinBoundaries(
  features: CountryBoundary["boundaryGeoJson"][],
): CountryBoundary["boundaryGeoJson"] | null {
  const polygons: Polygons = [];
  for (const f of features) {
    const { type, coordinates } = f.geometry;
    if (type === "Polygon") polygons.push(coordinates);
    else if (type === "MultiPolygon" && Array.isArray(coordinates)) polygons.push(...coordinates);
  }
  return polygons.length > 0 ? { type: "Feature", geometry: { type: "MultiPolygon", coordinates: polygons } } : null;
}

/** The downloaded countries a continent (or the world) map outlines. By the country's own
 *  continent: the picker's Central America group is only a grouping, and its countries still
 *  belong to North America. */
export function countriesInHub(
  countries: RegionSummary[],
  regionId: string,
  worldRegionId: string | undefined,
): RegionSummary[] {
  return countries.filter(
    (c) => regionId === worldRegionId || c.parentId === regionId || continentIdForCountry(c) === regionId,
  );
}

/** The countries a Collection view covers, for "Download animal groups": every downloaded country
 *  on All species, the downloaded ones on a hub, else the view's own country (a province's too). */
export function countriesInView(
  regionId: string | null,
  isHub: boolean,
  worldRegionId: string | undefined,
  downloadedCountries: RegionSummary[],
  countryAncestor: { id: string; name: string } | null,
): Array<{ id: string; name: string }> {
  if (!regionId) return downloadedCountries;
  if (isHub) return countriesInHub(downloadedCountries, regionId, worldRegionId);
  return countryAncestor ? [countryAncestor] : [];
}

export function useHubBoundary(
  regionId: string | null,
  isHub: boolean,
  worldRegionId: string | undefined,
  downloadedCountries: RegionSummary[],
): CountryBoundary["boundaryGeoJson"] | null {
  const all = countryBoundariesResource.use(isHub).data;
  return useMemo(() => {
    if (!isHub || !all || !regionId) return null;
    const inHub = new Map(countriesInHub(downloadedCountries, regionId, worldRegionId).map((c) => [c.id, c]));
    const shown = all.filter((b) => inHub.has(b.id));
    const joined = joinBoundaries(shown.map((b) => b.boundaryGeoJson));
    // Each country kept too, so the map frames them all by their own framings (mapCamera).
    const countries: HubCountry[] = shown.map((b) => ({
      outline: b.boundaryGeoJson,
      code: inHub.get(b.id)?.ebirdRegionCode ?? null,
    }));
    return joined && { ...joined, properties: { countries } };
  }, [isHub, all, regionId, worldRegionId, downloadedCountries]);
}
