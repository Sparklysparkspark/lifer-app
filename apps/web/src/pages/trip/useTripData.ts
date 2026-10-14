import { useCallback } from "react";
import type { CollectionItem } from "@lifer/shared";
import { api, apiPath } from "../../api/client";
import { toCollectionItems } from "../../api/types";
import { useApiResource, useApiRoute } from "../../lib/resource";
import type { TripDetail, TripPhoto } from "./types";

interface TripData {
  trip: TripDetail;
  photos: TripPhoto[];
  speciesItems: CollectionItem[];
}

// The trip, its photos and species: all three are needed before the page shows.
async function fetchTrip(id: string, signal: AbortSignal): Promise<TripData> {
  const [trip, photos, species] = await Promise.all([
    api.get(apiPath("/trips/{id}", { id }), { signal }),
    api.get(apiPath("/trips/{id}/photos", { id }), { signal }),
    api.get(apiPath("/trips/{id}/species", { id }), { signal }),
  ]);
  return { trip, photos: photos.items, speciesItems: toCollectionItems(species.items) };
}

// The trip's data plus the optional summary line. A different trip id starts from nothing, so the
// previous trip's data or error never shows under the new one.
export function useTripData(id: string | undefined) {
  const main = useApiResource(id ?? null, fetchTrip);
  // Supplementary, so a failure here doesn't block the trip itself.
  const summary = useApiRoute(id ? apiPath("/trips/{id}/summary", { id }) : null);
  const reloadMain = main.reload;
  const reloadSummary = summary.reload;

  // A reload after a change or a retry: any earlier error clears while it runs.
  const load = useCallback(async () => {
    await Promise.all([reloadMain(), reloadSummary()]);
  }, [reloadMain, reloadSummary]);

  return {
    trip: main.data?.trip ?? null,
    summary: summary.data,
    photos: main.data?.photos ?? null,
    speciesItems: main.data?.speciesItems ?? null,
    loadError: main.error != null,
    load,
  };
}
