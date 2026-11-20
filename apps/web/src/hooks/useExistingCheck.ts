// The check for photos the user already added to iNaturalist themselves (see
// pages/inaturalist/ExistingObservations.tsx for its bar and review cards).
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { JobStatus } from "@lifer/shared";
import { api } from "../api/client";
import { useJobPoll } from "./useJobPoll";
import { useLatest } from "./useLatest";
import { useToast } from "./useToast";

export type FindStatus = JobStatus<{
  read: number;
  linked: number;
  review: number;
  compared: boolean;
  linkedCaptureIds?: string[];
}> & {
  auto: boolean;
};

const SEEN_KEY = "lifer.inat.existingSeenAt";
const AUTO_EVERY_MS = 5 * 60_000;
const readSeen = () => {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? 0);
  } catch {
    return 0;
  }
};
const writeSeen = (at: number) => {
  try {
    localStorage.setItem(SEEN_KEY, String(at));
  } catch {
    // Private window: the note may show again, which is harmless.
  }
};

/** The check's status, polled while it runs (and now and then, to notice one Lifer started). A
 *  finished run is told once, with a toast, whoever started it and even if it ended before the
 *  page opened; `onFound` reloads the lists. */
export function useExistingCheck(onFound: () => Promise<void>, enabled = true) {
  const { t } = useTranslation();
  const toast = useToast();
  const found = useLatest(onFound);
  const job = useJobPoll<FindStatus>("/inaturalist/existing/status", {
    enabled,
    intervalMs: 1500,
    idleIntervalMs: 60_000,
  });
  const status = job.status;
  const refresh = job.refresh;

  // Opening the page asks for the quiet check, and asks again every few minutes while it stays open
  // and in view; the server decides whether a run is due. Not while one is already going.
  const running = useLatest(status?.running === true);
  useEffect(() => {
    if (!enabled) return;
    const ask = () => {
      if (running.current || document.visibilityState !== "visible") return;
      void api
        .post("/inaturalist/existing", { auto: true })
        .then(() => refresh())
        .catch(() => {});
    };
    ask();
    const timer = setInterval(ask, AUTO_EVERY_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh, running]);

  useEffect(() => {
    const r = status?.result;
    if (!status || status.running || !r || !status.finishedAt || status.finishedAt <= readSeen()) return;
    writeSeen(status.finishedAt);
    const linkedIds = r.linkedCaptureIds ?? [];
    if (r.linked > 0)
      toast.show(t("inaturalist.existing.linked", { count: r.linked }), {
        tone: "success",
        actions:
          linkedIds.length > 0
            ? [
                {
                  label: t("inaturalist.matches.undo"),
                  onClick: () =>
                    void api
                      .post("/inaturalist/matches/unlink", { captureIds: linkedIds })
                      .then(() => found.current())
                      .catch(() => toast.error(t("inaturalist.existing.failed"))),
                },
              ]
            : [],
      });
    else if (!status.auto && r.review === 0) toast.success(t("inaturalist.existing.noneFound"));
    if (r.linked > 0 || r.review > 0) void found.current();
  }, [status, found, t, toast]);

  const start = async () => {
    if (!(await job.start("/inaturalist/existing"))) toast.error(t("inaturalist.existing.failed"));
  };
  const cancel = () => void job.cancel("/inaturalist/existing/cancel");
  return { status, start, cancel, cancelling: job.cancelling };
}
