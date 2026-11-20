import { useTranslation } from "react-i18next";
import type { RemoteState } from "../lib/packIndex";
import { useTimeLeft } from "../hooks/useTimeLeft";
import { timeLeftLabel } from "../lib/timeLeft";
import InlineSpinner from "./InlineSpinner";

/** The one "offline" or "slow connection" line on download screens (see useConnection). Nothing
 *  when online. Slow never disables anything: a download just takes longer. */
export default function ConnectionNote({ state, className = "" }: { state: RemoteState; className?: string }) {
  const { t } = useTranslation();
  if (state === "online") return null;
  return (
    <p role="status" className={`flex items-center gap-2 text-callout text-muted ${className}`}>
      {state === "slow" && <InlineSpinner />}
      {t(state === "slow" ? "offlinePacks.slow" : "offlinePacks.offline")}
    </p>
  );
}

/** While the list of downloads is still coming in (a weak signal takes minutes for it): how far it
 *  has got and roughly how long is left, instead of an endless spinner. */
export function ListLoadingNote({
  progress,
  className = "",
}: {
  progress: { receivedBytes: number; totalBytes: number | null } | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const total = progress?.totalBytes ?? null;
  const percent = progress && total ? Math.floor((progress.receivedBytes / total) * 100) : null;
  const left = timeLeftLabel(useTimeLeft(progress?.receivedBytes ?? null, total), t, false);
  return (
    <p role="status" className={`flex flex-wrap items-center gap-x-2 text-callout text-muted ${className}`}>
      <InlineSpinner />
      {percent == null
        ? t("collection.addGroups.loadingList")
        : t("collection.addGroups.loadingListPercent", { percent })}
      {left && <span className="text-footnote">{left}</span>}
    </p>
  );
}
