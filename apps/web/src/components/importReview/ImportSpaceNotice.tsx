import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "../../lib/format";
import type { ImportSpace } from "../../lib/importSpace";
import Button from "../Button";

/** The Import page's line about a nearly full drive: a calm note while it is tight, and when the
 *  import paused, how far it got and how much to free, with Continue to check again and go on. */
export default function ImportSpaceNotice({
  space,
  paused,
  onContinue,
}: {
  space: ImportSpace | null;
  /** Set when the import stopped for space: photos imported of the ones it set out to import. */
  paused: { imported: number; total: number } | null;
  onContinue: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const stopped = paused || space?.tier === "critical";
  if (!stopped) {
    if (space?.tier !== "tight") return null;
    return (
      <p role="status" className="text-footnote text-muted">
        {t("import.space.tight")}
      </p>
    );
  }
  const amounts = {
    free: formatBytes(space?.free ?? 0),
    toFree: formatBytes(Math.max(space?.toFree ?? 0, 1e9)),
  };
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-panel bg-surface-muted px-4 py-3">
      <p className="min-w-0 flex-1 text-callout text-ink">
        {paused
          ? t("import.space.paused", { ...amounts, imported: paused.imported, total: paused.total })
          : t("import.space.full", amounts)}
      </p>
      <Button
        size="sm"
        loading={busy}
        onClick={() => {
          setBusy(true);
          void onContinue().finally(() => setBusy(false));
        }}
      >
        {t("import.space.continue")}
      </Button>
    </div>
  );
}
