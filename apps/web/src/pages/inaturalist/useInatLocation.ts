// A location set in Lifer for observations sent without one: the photos are filed under the place
// (the shared place step, with its Undo), then iNaturalist is updated in the background. Offline,
// the server keeps it waiting and the To finish check sends it later.
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { usePlaceStep } from "../../hooks/usePlaceStep";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";

const POLL_MS = 1000;

export interface LocationTarget {
  observationId: string;
  captureIds?: string[];
}

export function useInatLocation(onChanged: () => unknown) {
  const { t } = useTranslation();
  const toast = useToast();
  const placeStep = usePlaceStep();

  async function send(observationIds: string[], conflict?: "replace" | "keep"): Promise<void> {
    let started: boolean;
    try {
      ({ started } = await api.post("/inaturalist/observations/location", {
        observationIds,
        ...(conflict ? { conflict } : {}),
      }));
    } catch (err) {
      toast.error(errorMessage(err, t("inaturalist.location.saveFailed")));
      return;
    }
    // Shows "Waiting to send" on the cards at once.
    void onChanged();
    if (conflict === "keep") return;
    if (!started) {
      toast.info(t("inaturalist.location.savedOffline"));
      return;
    }
    const working = toast.show(t("inaturalist.location.sending"), { durationMs: null });
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const status = await api.get("/inaturalist/observations/location/status");
        if (status.running) continue;
        toast.dismiss(working);
        if (status.error || !status.result) toast.error(status.error ?? t("inaturalist.location.saveFailed"));
        else summarise(status.result);
        break;
      }
    } catch (err) {
      toast.dismiss(working);
      toast.error(errorMessage(err, t("inaturalist.location.saveFailed")));
    }
    void onChanged();
  }

  function summarise(r: { updated: number; waiting: number; failed: number; conflictIds: string[] }) {
    const total = r.updated + r.waiting + r.failed;
    if (total > 0 && r.updated === total) toast.success(t("inaturalist.location.updated", { count: r.updated }));
    else if (total > 0 && r.waiting === total) toast.info(t("inaturalist.location.savedOffline"));
    else if (total > 0)
      toast.show(
        t("inaturalist.location.summary", { updated: r.updated, total, waiting: r.waiting, failed: r.failed }),
      );
    const ids = r.conflictIds;
    if (ids.length > 0)
      toast.show(t("inaturalist.location.conflict", { count: ids.length }), {
        durationMs: null,
        actions: [
          { label: t("inaturalist.location.replace"), onClick: () => void send(ids, "replace") },
          { label: t("inaturalist.location.keep"), onClick: () => void send(ids, "keep") },
        ],
      });
  }

  return {
    /** Asks for a place, files the photos under it, then sends it to iNaturalist. */
    async setLocation(list: LocationTarget[]) {
      const captureIds = [...new Set(list.flatMap((o) => o.captureIds ?? []))];
      if (!placeStep || captureIds.length === 0) return;
      if ((await placeStep({ captureIds, near: null, looksLike: null, send: false })) !== "placed") return;
      await send(list.map((o) => o.observationId));
    },
    retry: (ids: string[]) => send(ids),
    replace: (ids: string[]) => send(ids, "replace"),
    keep: (ids: string[]) => send(ids, "keep"),
  };
}
