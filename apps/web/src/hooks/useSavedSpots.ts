import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { JobStatus } from "@lifer/shared";
import { api, apiPath } from "../api/client";
import type { SavedSpot } from "../components/SavedSpots";
import { errorMessage } from "../lib/errorMessage";
import { formatNumber } from "../lib/format";
import { ignore } from "../lib/ignore";
import { useAnnounceSuggestionChanges } from "./useAnnounceSuggestionChanges";
import { useJobPoll } from "./useJobPoll";
import { useToast } from "./useToast";

export function useSavedSpots() {
  const [spots, setSpots] = useState<SavedSpot[] | null>(null);
  const [nearby, setNearby] = useState<Record<string, number>>({});
  const reload = useCallback(
    () =>
      Promise.all([api.get("/saved-spots"), api.get("/saved-spots/suggestions")])
        .then(([list, near]) => {
          setSpots(list.spots);
          setNearby(Object.fromEntries(near.suggestions.map((s) => [s.spotId, s.photoCount])));
        })
        .catch(ignore("Couldn't load saved spots")),
    [],
  );
  useEffect(() => void reload(), [reload]);
  return { spots, nearby, reload };
}

type LocationJobStatus = JobStatus<{ applied: number; spotName: string | null }> & { canUndo: boolean };

/** Puts back the latest location change (one shared history: places, spots, removals). */
export function useUndoLocation(onChanged: () => unknown) {
  const { t } = useTranslation();
  const toast = useToast();
  return useCallback(
    () =>
      api
        .post("/captures/location/undo")
        .then((res) => {
          void onChanged();
          if (res.restored === 0) toast.info(t("gallery.map.nothingToUndo"));
        })
        .catch((err) => toast.error(errorMessage(err, t("savedSpots.undoFailed")))),
    [onChanged, t, toast],
  );
}

/** Big location changes (filing under a spot, placing over 5,000 photos) as one background job,
 *  with an Undo toast when it's done. */
export function useLocationJob(onChanged: () => unknown) {
  const { t } = useTranslation();
  const toast = useToast();
  const announceSuggestionChanges = useAnnounceSuggestionChanges();
  const undo = useUndoLocation(onChanged);
  return useJobPoll<LocationJobStatus>("/captures/location/status", {
    onFinish: (status) => {
      void onChanged();
      if (status.error) return toast.error(status.error);
      if (status.cancelled || !status.result) return;
      const { applied, spotName } = status.result;
      if (spotName) announceSuggestionChanges();
      toast.show(
        spotName
          ? t("savedSpots.applied", { count: applied })
          : t("gallery.map.placed", { count: applied, formatted: formatNumber(applied) }),
        { tone: "success", actions: [{ label: t("savedSpots.undo"), onClick: () => void undo() }] },
      );
    },
  });
}

export interface FarPhotos {
  spotId: string;
  captureIds: string[];
  count: number;
  km: number;
}

/** Files photos under a saved place: photos with their own point keep it, photos without one take
 *  the place's centre. When some were taken far from it, `far` asks first instead. */
export function useFileUnderPlace(onChanged: () => unknown) {
  const { t } = useTranslation();
  const toast = useToast();
  const undo = useUndoLocation(onChanged);
  const [far, setFar] = useState<FarPhotos | null>(null);

  const apply = useCallback(
    async (spotId: string, captureIds: string[], moveOwnPoints = false) => {
      const res = await api.post(apiPath("/saved-spots/{id}/apply", { id: spotId }), {
        captureIds,
        moveOwnPoints,
        wait: true,
      });
      setFar(null);
      // Over 5,000 photos it runs as the location job: wait for it, so whatever follows (a send) sees it done.
      if (res.applied === undefined)
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const status = await api.get("/captures/location/status");
          if (status.running) continue;
          if (status.error) throw new Error(status.error);
          break;
        }
      void onChanged();
      const count = res.applied ?? captureIds.length;
      toast.show(t("savedSpots.applied", { count }), {
        tone: "success",
        actions: [{ label: t("savedSpots.undo"), onClick: () => void undo() }],
      });
    },
    [onChanged, t, toast, undo],
  );

  /** True when the photos were filed; false when `far` now asks first. */
  const file = useCallback(
    async (spotId: string, captureIds: string[]) => {
      const found = await api.post(apiPath("/saved-spots/{id}/far", { id: spotId }), { captureIds });
      if (found.count > 0) {
        setFar({ spotId, captureIds, ...found });
        return false;
      }
      await apply(spotId, captureIds);
      return true;
    },
    [apply],
  );

  return {
    file,
    far,
    /** Files the far photos too: keeping their own points, or moving them to the place. */
    confirm: (moveOwnPoints: boolean) => (far ? apply(far.spotId, far.captureIds, moveOwnPoints) : Promise.resolve()),
    dismiss: () => setFar(null),
  };
}
