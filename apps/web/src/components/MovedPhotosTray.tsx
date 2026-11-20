import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useJobPoll } from "../hooks/useJobPoll";
import {
  MOVED_PHOTOS_CHANGED,
  MOVED_PHOTOS_LOOK_STARTED,
  OPEN_REVIEW,
  movedPhotosChanged,
  useTripFolderActions,
  useUndoRelinks,
  type MovedPhotosStatus,
} from "../hooks/useMovedPhotos";
import { useToast } from "../hooks/useToast";
import { ignore } from "../lib/ignore";
import JobProgress from "./JobProgress";

const STATUS_URL = "/moved-photos/status";
// Lifer looks on its own too, so the tray checks now and then for news to show.
const IDLE_POLL_MS = 30_000;

// Moved photos Lifer found: one quiet toast with Undo for each set it relinked, an offer for a
// trip whose folder moved, and progress (bottom left, positioned by StatusTray) only while a look
// the user asked for runs.
export default function MovedPhotosTray() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const undo = useUndoRelinks();
  const tripFolder = useTripFolderActions();
  const shown = useRef(new Set<string>());

  const job = useJobPoll<MovedPhotosStatus>(STATUS_URL, {
    idleIntervalMs: IDLE_POLL_MS,
    onFinish: (status) => {
      const r = status.result;
      if (status.error && status.manual) toast.error(t("movedPhotos.failed"));
      if (!r) return;
      if (r.relinked > 0 || r.proposals > 0) movedPhotosChanged();
      if (r.review > 0)
        toast.show(t("movedPhotos.toReview", { count: r.review }), {
          durationMs: null,
          actions: [
            {
              label: t("movedPhotos.review"),
              onClick: () => navigate("/settings/storage", { state: { [OPEN_REVIEW]: true } }),
            },
          ],
        });
      // Only a look the user asked for says it found nothing.
      else if (status.manual && r.relinked === 0 && r.proposals === 0)
        toast.info(
          [
            t("movedPhotos.noneFound"),
            r.unreadableFolders > 0 ? t("movedPhotos.unreadable", { count: r.unreadableFolders }) : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
    },
  });

  const { refresh } = job;
  useEffect(() => {
    const follow = () => void refresh();
    window.addEventListener(MOVED_PHOTOS_LOOK_STARTED, follow);
    window.addEventListener(MOVED_PHOTOS_CHANGED, follow);
    return () => {
      window.removeEventListener(MOVED_PHOTOS_LOOK_STARTED, follow);
      window.removeEventListener(MOVED_PHOTOS_CHANGED, follow);
    };
  }, [refresh]);

  const status = job.status;
  useEffect(() => {
    if (!status) return;
    const batchIds: string[] = [];
    const tripIds: string[] = [];
    const notice = status.notice;
    if (notice && !shown.current.has(notice.batchId)) {
      shown.current.add(notice.batchId);
      batchIds.push(notice.batchId);
      toast.show(t("movedPhotos.found", { count: notice.count }), {
        tone: "success",
        actions: [{ label: t("movedPhotos.undo"), onClick: () => void undo(notice.batchId) }],
      });
    }
    for (const p of status.proposals) {
      if (p.announced || shown.current.has(p.tripId)) continue;
      shown.current.add(p.tripId);
      tripIds.push(p.tripId);
      toast.show(t("movedPhotos.tripFolderMoved", { trip: p.tripName, folder: p.folder }), {
        durationMs: null,
        actions: [
          { label: t("movedPhotos.useIt"), onClick: () => void tripFolder.accept(p.tripId) },
          { label: t("movedPhotos.notNow"), onClick: () => void tripFolder.dismiss(p.tripId) },
        ],
      });
    }
    if (batchIds.length + tripIds.length > 0)
      api.post("/moved-photos/ack", { batchIds, tripIds }).catch(ignore("Couldn't mark moved photos as shown"));
  }, [status, t, toast, undo, tripFolder]);

  if (!status?.running || !status.manual) return null;
  return (
    <div
      role="status"
      aria-label={t("movedPhotos.trayLabel")}
      className="w-96 max-w-full rounded-panel border border-line bg-surface p-3 shadow-sm"
    >
      <JobProgress
        compact
        status={status}
        phases={{
          checking: { label: t("movedPhotos.phase.checking"), progress: "none" },
          looking: { label: t("movedPhotos.phase.looking"), progress: "none" },
          matching: { label: t("movedPhotos.phase.matching"), progress: "count" },
        }}
        onCancel={() => void job.cancel("/moved-photos/cancel")}
        cancelling={job.cancelling}
      />
    </div>
  );
}
