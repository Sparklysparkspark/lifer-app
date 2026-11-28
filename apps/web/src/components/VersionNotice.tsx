// "Found 4 versions of 2 photos": a short, dismissible line the first time the background pass
// groups prints, edits and exports from an import (apps/api/src/uploads/versionGrouping.ts). An
// explainer, so once dismissed it never comes back on this device.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { apiPath } from "../api/client";
import { useApiRoute } from "../lib/resource";
import { usePersistedState } from "../hooks/usePersistedState";
import { refreshVersionCounts } from "../lib/photoVersions";
import { docsUrl } from "../lib/docs";
import { openExternal } from "../lib/openExternal";
import Button, { IconButton } from "./Button";

// Grouping waits for an import to go quiet, so a page left open checks again now and then.
const RECHECK_MS = 20_000;

/** What was grouped since the notice was last dismissed on this device. */
export function useVersionNotice() {
  const [seen, setSeen] = usePersistedState<string>("versionNoticeSeen", "");
  const res = useApiRoute(
    apiPath("/captures/version-summary", {}, seen ? new URLSearchParams({ since: seen }) : undefined),
  );
  const reload = res.reload;
  useEffect(() => {
    const timer = setInterval(() => void reload(), RECHECK_MS);
    return () => clearInterval(timer);
  }, [reload]);
  const latest = res.data?.latest ?? null;
  // New groups: every badge follows.
  useEffect(() => {
    if (latest) void refreshVersionCounts();
  }, [latest]);
  return {
    versions: res.data?.versions ?? 0,
    photos: res.data?.photos ?? 0,
    visible: !seen && (res.data?.versions ?? 0) > 0,
    dismiss: () => latest && setSeen(latest),
  };
}

export type VersionNoticeState = ReturnType<typeof useVersionNotice>;

export default function VersionNotice({ notice }: { notice: VersionNoticeState }) {
  const { t } = useTranslation();
  if (!notice.visible) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-control border border-accent/40 bg-accent/10 px-3 py-2 text-footnote text-ink"
    >
      <span className="min-w-0 flex-1 basis-64">
        {t("versions.notice.found", { versions: notice.versions, photos: notice.photos })}
      </span>
      <Button variant="link" size="sm" onClick={() => openExternal(docsUrl("/guides/photo-versions"))}>
        {t("versions.notice.howItWorks")}
      </Button>
      <IconButton tone="plain" onClick={notice.dismiss} aria-label={t("versions.notice.dismiss")}>
        ✕
      </IconButton>
    </div>
  );
}
