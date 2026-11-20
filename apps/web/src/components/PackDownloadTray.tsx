import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { usePackDownloadJob } from "../hooks/usePackDownloadStatus";
import { useToast } from "../hooks/useToast";
import PackProgress, { usePackProgressShownInPage } from "./PackProgress";

const CANCEL_URL = "/offline-packs/download/cancel";

// A pack download's progress on every page (positioned by StatusTray), so it follows the user
// out of onboarding or Settings. Hidden where a page already shows it in place.
export default function PackDownloadTray() {
  const { t } = useTranslation();
  const toast = useToast();
  const shownInPage = usePackProgressShownInPage();
  // Whether the tray was the one showing the run, so its outcome isn't announced twice.
  const visible = useRef(false);
  const job = usePackDownloadJob({
    onFinish: (status) => {
      if (!visible.current || status.cancelled) return;
      if (status.error)
        toast.show(t("offlinePacks.status.failed", { error: status.error }), { tone: "error", durationMs: null });
      else
        toast.success(t("offlinePacks.status.done", { count: status.result?.packsApplied ?? status.processed ?? 0 }));
    },
  });
  const show = !!job.status?.running && !shownInPage;
  useEffect(() => {
    visible.current = show;
  }, [show]);
  if (!show) return null;
  return (
    <div
      role="status"
      aria-label={t("packProgress.trayLabel")}
      className="w-96 max-w-full rounded-panel border border-line bg-surface p-3 shadow-sm"
    >
      <PackProgress
        inTray
        status={job.status}
        onCancel={(downloadsOnly) => void job.cancel(CANCEL_URL, downloadsOnly ? { downloadsOnly } : undefined)}
        cancelling={job.cancelling}
      />
    </div>
  );
}
