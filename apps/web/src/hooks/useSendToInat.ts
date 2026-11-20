import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import { usePlaceStep } from "./usePlaceStep";
import { useToast } from "./useToast";
import { openExternal } from "../lib/openExternal";

const POLL_MS = 1000;

export interface SendOptions {
  /** Only from the user's own Send anyway: skips the check for an observation already there. */
  ignoreExistingGuard?: boolean;
  /** Shows held-back sightings in place (the To send tab); otherwise a toast offers the choice. */
  onMaybeOnInat?: (groups: string[][]) => void;
}

/** Where the review list is: To send, Maybe on iNaturalist. */
export const MAYBE_ON_INAT_PATH = "/inaturalist?tab=import&show=matches";

/** Sends photos to iNaturalist as observations in the background. Plain capture ids are grouped
 *  into sightings by the server (one per species and session); `{ groups }` sends each group as
 *  exactly one observation. Photos already sent are skipped; ignored ones are sent and leave
 *  Ignored, since sending them is a choice. Resolves true when
 *  something was sent, so a grid can reload its badges. */
export function useSendToInat() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const placeStep = usePlaceStep();

  return async function send(target: string[] | { groups: string[][] }, opts: SendOptions = {}): Promise<boolean> {
    // Photos from the Gallery may have no location: offer a place first, never required.
    if (Array.isArray(target) && placeStep) {
      const hints = await api.post("/places/send-hints", { captureIds: target }).catch(() => null);
      if (hints && hints.withoutLocation.length > 0) {
        const chosen = await placeStep({
          captureIds: hints.withoutLocation,
          near: hints.point,
          looksLike: hints.looksLike,
          send: true,
          offerWithout: true,
        });
        if (chosen === null) return false;
      }
    }
    try {
      await api.post("/inaturalist/observations/batch", {
        ...(Array.isArray(target) ? { captureIds: target } : target),
        ...(opts.ignoreExistingGuard ? { ignoreExistingGuard: true } : {}),
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("inaturalist.import.createFailed"));
      return false;
    }
    const working = toast.show(t("inaturalist.send.sending"), {
      durationMs: null,
      actions: [{ label: t("common.cancel"), onClick: () => void api.post("/inaturalist/observations/batch/cancel") }],
    });
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const status = await api.get("/inaturalist/observations/batch/status");
        if (status.running) continue;
        toast.dismiss(working);
        const r = status.result;
        if (status.error || !r) {
          toast.error(status.error ?? t("inaturalist.import.createFailed"));
          return false;
        }
        // Sightings already on iNaturalist were linked, not sent twice.
        if (r.linked > 0) toast.success(t("inaturalist.send.linkedExisting", { count: r.linked }));
        // Ones that may be there are held back, with the choice to check or send anyway.
        const held = r.maybeOnInat ?? [];
        if (held.length > 0) {
          if (opts.onMaybeOnInat) opts.onMaybeOnInat(held);
          else
            toast.show(t("inaturalist.send.maybeOnInat", { count: held.length }), {
              durationMs: null,
              actions: [
                { label: t("inaturalist.send.checkMatches"), onClick: () => navigate(MAYBE_ON_INAT_PATH) },
                {
                  label: t("inaturalist.send.sendAnyway"),
                  onClick: () => void send({ groups: held }, { ignoreExistingGuard: true }),
                },
              ],
            });
        }
        if (r.sent === 0) {
          if (r.linked > 0 || held.length > 0) return r.linked > 0;
          toast.error(r.error ?? t("inaturalist.send.nothingToSend"));
          return false;
        }
        if (r.incomplete === 0) {
          toast.success(t("inaturalist.send.sent", { count: r.sent }));
        } else if (r.editUrl) {
          // One observation: take them straight to iNaturalist's map to place it.
          toast.success(t("inaturalist.send.sentOneIncomplete"));
          openExternal(r.editUrl);
        } else {
          toast.show(t("inaturalist.send.sentIncomplete", { count: r.sent, incomplete: r.incomplete }), {
            actions: [{ label: t("inaturalist.send.finish"), onClick: () => navigate("/inaturalist?tab=pending") }],
          });
        }
        if (r.failed > 0 && r.error) toast.error(r.error);
        return true;
      }
    } catch (err) {
      toast.dismiss(working);
      toast.error(err instanceof ApiError ? err.message : t("inaturalist.import.createFailed"));
      return false;
    }
  };
}
