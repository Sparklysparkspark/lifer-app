import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { ignore } from "../lib/ignore";
import { useToast } from "./useToast";

const POLL_MS = 1000;
const MAX_POLLS = 30;

/** After photos get a region, tells the user when suggestions Lifer had filed for them changed.
 *  Polls the background re-check and says nothing when no suggestion changed. */
export function useAnnounceSuggestionChanges(): () => void {
  const toast = useToast();
  const { t } = useTranslation();
  return useCallback(() => {
    void (async () => {
      for (let i = 0; i < MAX_POLLS; i++) {
        const res = await api.post("/captures/recheck/poll");
        if (!res.running) {
          if (res.changed > 0) toast.info(t("suggestionsRecheck.changed", { count: res.changed }));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    })().catch(ignore("Couldn't check for changed suggestions"));
  }, [toast, t]);
}
