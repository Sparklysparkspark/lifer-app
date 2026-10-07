import { useEffect, useState } from "react";
import type { CollectionItem } from "@lifer/shared";
import { api } from "../../api/client";
import type { TripDetail, TripPhoto, TripSummary } from "./types";

// The trip, its photos and species (all three needed before the page shows), plus the optional
// summary line.
export function useTripData(id: string | undefined) {
  const [trip, setTrip] = useState<TripDetail | null>(null);
  const [summary, setSummary] = useState<TripSummary | null>(null);
  const [photos, setPhotos] = useState<TripPhoto[] | null>(null);
  const [speciesItems, setSpeciesItems] = useState<CollectionItem[] | null>(null);
  // The trip whose load failed, so opening another trip starts without the old error.
  const [failedId, setFailedId] = useState<string | null>(null);
  const loadError = !!id && failedId === id;

  function fetchTrip(): Promise<void> {
    if (!id) return Promise.resolve();
    const tripId = id;
    // Supplementary, so a failure here doesn't block the trip itself.
    api
      .get<TripSummary>(`/trips/${id}/summary`)
      .then(setSummary)
      .catch(() => {});
    return Promise.all([
      api.get<TripDetail>(`/trips/${id}`),
      api.get<{ items: TripPhoto[] }>(`/trips/${id}/photos`),
      api.get<{ items: CollectionItem[] }>(`/trips/${id}/species`),
    ])
      .then(([tripRes, photosRes, speciesRes]) => {
        setTrip(tripRes);
        setPhotos(photosRes.items);
        setSpeciesItems(speciesRes.items);
      })
      .catch(() => setFailedId(tripId));
  }

  // A reload after a change or a retry: any earlier error clears while it runs.
  function load(): Promise<void> {
    setFailedId(null);
    return fetchTrip();
  }

  useEffect(() => {
    void fetchTrip();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return { trip, summary, photos, speciesItems, loadError, load };
}
