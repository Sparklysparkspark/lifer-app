import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { PackDownloadStatus } from "@lifer/shared";
import { packProgressRow, type PackProgressRow } from "../lib/packProgress";
import { timeLeftLabel } from "../lib/timeLeft";
import { useTimeLeft } from "../hooks/useTimeLeft";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import Button from "./Button";
import Menu, { MenuItems, MenuPanel } from "./Menu";
import ProgressBar from "./ProgressBar";

// How many pages show the download's progress in place; the StatusTray shows it only when none does.
let shownInPage = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const usePackProgressShownInPage = () => useSyncExternalStore(subscribe, () => shownInPage > 0);

// Keyed by the row's kind, so a switch from downloading to setting up measures afresh.
function RowDetail({ row, stopping }: { row: PackProgressRow; stopping: boolean }) {
  const { t } = useTranslation();
  // Rows already say what they're doing, so only a measured time is added, never "Loading".
  const left = timeLeftLabel(useTimeLeft(row.eta?.done ?? null, row.eta?.total ?? null), t, false);
  const time = stopping ? null : left;
  if (!row.detail && !row.note && !time) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 text-footnote text-muted">
      <p className="min-w-0 truncate" title={row.detail ?? undefined}>
        {[row.detail, row.note].filter(Boolean).join(". ")}
      </p>
      {time && <span className="shrink-0 tabular-nums">{time}</span>}
    </div>
  );
}

/** A running pack download as one bar: what it downloads, or once nothing does, the set-up on
 *  this computer. One Cancel menu: stop downloading (what's on disk still sets up) or stop
 *  everything. Nothing when idle. */
export default function PackProgress({
  status,
  onCancel,
  cancelling = false,
  inTray = false,
}: {
  status: PackDownloadStatus | null;
  onCancel?: (downloadsOnly: boolean) => void;
  cancelling?: boolean;
  inTray?: boolean;
}) {
  const { t } = useTranslation();
  const menu = useDropdownMenu();
  const running = !!status?.running;
  useEffect(() => {
    if (inTray || !running) return;
    shownInPage++;
    notify();
    return () => {
      shownInPage--;
      notify();
    };
  }, [inTray, running]);
  if (!status?.running) return null;

  const row = packProgressRow(status, t);
  const stopping = cancelling || status.cancelRequested;
  const { download } = status.lanes;
  const downloading = download.total > 0 && download.processed < download.total;
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 text-callout font-medium text-ink">{stopping ? t("ui.job.cancelling") : row.title}</p>
          {row.amount && <span className="shrink-0 text-footnote text-muted tabular-nums">{row.amount}</span>}
        </div>
        <ProgressBar
          value={row.fraction}
          determinate={row.fraction !== null}
          size="xs"
          resetKey={`${row.key}:${row.detail ?? ""}`}
          label={row.title}
        />
        <RowDetail key={row.key} row={row} stopping={stopping} />
        {row.also && !stopping && <p className="text-footnote text-muted">{row.also}</p>}
      </div>
      {onCancel &&
        (downloading ? (
          <Menu
            open={menu.openKey === true}
            onToggle={() => menu.setOpenKey(menu.openKey ? null : true)}
            menuRef={menu.ref}
            className="relative shrink-0"
            trigger={(props) => (
              <Button variant="secondary" size="sm" disabled={stopping} {...props}>
                {t("common.cancel")}
              </Button>
            )}
          >
            <MenuPanel className="whitespace-nowrap">
              <MenuItems
                items={[
                  { label: t("packProgress.stopDownloads"), onSelect: () => onCancel(true) },
                  { label: t("packProgress.stopAll"), onSelect: () => onCancel(false) },
                ]}
              />
            </MenuPanel>
          </Menu>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={stopping}
            onClick={() => onCancel(false)}
            className="shrink-0"
          >
            {t("common.cancel")}
          </Button>
        ))}
    </div>
  );
}
