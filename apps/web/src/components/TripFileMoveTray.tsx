import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ApiResponse } from "../api/client";
import { useJobPoll } from "../hooks/useJobPoll";
import { useToast } from "../hooks/useToast";
import JobProgress from "./JobProgress";
import Modal from "./Modal";
import Button from "./Button";

type MoveStatus = ApiResponse<"/trips/move-files/status">;
type MoveResult = NonNullable<MoveStatus["result"]>;
export type TripFileDetail = MoveResult["details"][number];

/** Fired by whoever starts a move, so the tray starts following it. */
export const TRIP_FILE_MOVE_STARTED = "lifer:trip-file-move-started";
/** Fired when a move ends, with the trip's id as `detail`, so its page reloads its folder. */
export const TRIP_FILES_MOVED = "lifer:trip-files-moved";

const REASON_KEYS: Record<TripFileDetail["reason"], string> = {
  missing: "trips.files.reason.missing",
  notManaged: "trips.files.reason.notManaged",
  outside: "trips.files.reason.outside",
  sizeDiffers: "trips.files.reason.sizeDiffers",
  failed: "trips.files.reason.failed",
};

const STATUS_URL = "/trips/move-files/status";
const CANCEL_URL = "/trips/move-files/cancel";

/** The files a move or relink left alone, with why, in a list that scrolls. */
export function TripFileDetailList({ details, more }: { details: TripFileDetail[]; more: number }) {
  const { t } = useTranslation();
  return (
    <div className="max-h-80 overflow-y-auto">
      <ul className="divide-y divide-line text-callout">
        {details.map((d) => (
          <li key={`${d.reason}:${d.file}`} className="flex min-w-0 flex-col gap-0.5 py-2">
            <span className="break-all text-ink">{d.file}</span>
            <span className="text-footnote text-muted">
              {d.reason === "failed" && d.message ? d.message : t(REASON_KEYS[d.reason])}
            </span>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="pt-2 text-footnote text-muted">{t("trips.files.moreDetails", { count: more })}</p>}
    </div>
  );
}

function summary(r: MoveResult, t: TFunction): string {
  const parts = [t("trips.files.summary", { moved: r.moved, skipped: r.skipped, missing: r.missing })];
  if (r.linkedMoved > 0) parts.push(t("trips.files.linkedMoved", { count: r.linkedMoved }));
  if (r.failed > 0) parts.push(t("trips.files.failed", { count: r.failed }));
  if (r.stopReason) parts.push(t("trips.files.stopped", { reason: r.stopReason }));
  parts.push(r.folderUpdated ? t("trips.files.savedTo", { folder: r.folder }) : t("trips.files.notFinished"));
  return parts.join(" ");
}

// A trip's files moving, on every page (positioned by StatusTray), with Cancel. When it ends, a
// toast sums it up and "Show details" lists the files left behind.
export default function TripFileMoveTray() {
  const { t } = useTranslation();
  const toast = useToast();
  const [details, setDetails] = useState<MoveResult | null>(null);
  const job = useJobPoll<MoveStatus>(STATUS_URL, {
    onFinish: (status) => {
      if (status.tripId) window.dispatchEvent(new CustomEvent(TRIP_FILES_MOVED, { detail: status.tripId }));
      if (status.cancelled) toast.info(t("trips.files.cancelled", { count: status.moved }));
      else if (status.error) toast.show(status.error, { tone: "error", durationMs: null });
      else if (status.result) {
        const result = status.result;
        const clean = result.folderUpdated && result.details.length === 0;
        toast.show(summary(result, t), {
          tone: clean ? "success" : "info",
          durationMs: clean ? undefined : null,
          actions:
            result.details.length > 0
              ? [{ label: t("trips.files.showDetails"), onClick: () => setDetails(result) }]
              : [],
        });
      }
    },
  });
  const { refresh } = job;
  useEffect(() => {
    const follow = () => void refresh();
    window.addEventListener(TRIP_FILE_MOVE_STARTED, follow);
    return () => window.removeEventListener(TRIP_FILE_MOVE_STARTED, follow);
  }, [refresh]);

  const status = job.status;
  return (
    <>
      {status?.running && (
        <div
          role="status"
          aria-label={t("trips.files.trayLabel")}
          className="w-96 max-w-full rounded-panel border border-line bg-surface p-3 shadow-sm"
        >
          <JobProgress
            compact
            status={status}
            phases={{
              checking: t("trips.files.phase.checking"),
              moving: {
                label: t("trips.files.phase.moving", { trip: status.tripName ?? "" }),
                progress: "count",
              },
              finishing: t("trips.files.phase.finishing"),
            }}
            onCancel={() => void job.cancel(CANCEL_URL)}
            cancelling={job.cancelling}
          />
        </div>
      )}
      <Modal
        open={!!details}
        onClose={() => setDetails(null)}
        title={t("trips.files.detailsTitle", { trip: details?.tripName ?? "" })}
        footer={<Button onClick={() => setDetails(null)}>{t("common.done")}</Button>}
      >
        {details && <TripFileDetailList details={details.details} more={details.moreDetails} />}
      </Modal>
    </>
  );
}
