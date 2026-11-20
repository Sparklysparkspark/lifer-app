import { useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "../Button";
import Panel from "../Panel";
import ProgressBar from "../ProgressBar";
import { formatNumber } from "../../lib/format";
import type { KnownFile } from "../../lib/knownFiles";

// Long lists stay quick: the rest are still covered by "Import all anyway".
const SHOWN = 300;

// Picked files the library already has (imported, or left out before) are never uploaded or
// checked: one quiet line says how many, and "Show them" lists them with Import anyway.
export default function KnownFiles({
  known,
  fresh,
  edited,
  checking,
  onImportAnyway,
}: {
  known: KnownFile[];
  /** New files from the same picks. */
  fresh: number;
  /** New files that look like edited copies of imported photos. */
  edited: number;
  /** Files fingerprinted so far, while a big pick is still being sorted. */
  checking: { done: number; total: number } | null;
  onImportAnyway: (files: KnownFile[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (known.length === 0 && edited === 0 && !checking) return null;
  const n = (count: number) => ({ count, formatted: formatNumber(count) });

  return (
    <section className="space-y-2" data-known-files>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-callout text-muted">
        {known.length > 0 && (
          <span>
            {fresh > 0
              ? t("import.known.summary", { known: formatNumber(known.length), fresh: formatNumber(fresh) })
              : t("import.known.nothingNew", n(known.length))}
          </span>
        )}
        {edited > 0 && <span>{t("import.known.edited", n(edited))}</span>}
        {known.length > 0 && (
          <Button variant="link" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? t("import.known.hide") : t("import.known.show")}
          </Button>
        )}
        {open && known.length > 1 && (
          <Button variant="link" size="sm" className="ml-auto" onClick={() => onImportAnyway(known)}>
            {t("import.skipped.importAll")}
          </Button>
        )}
      </div>
      {checking && (
        <ProgressBar
          value={checking.total > 0 ? checking.done / checking.total : 0}
          size="xs"
          label={t("import.known.checking", n(checking.total))}
          className="max-w-xs"
        />
      )}
      {open && known.length > 0 && (
        <Panel grouped>
          {known.slice(0, SHOWN).map((k, i) => (
            <div key={k.path ?? `${i}-${k.name}`} className="flex flex-wrap items-center gap-3 p-3" data-known-row>
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-callout text-ink wrap-anywhere">{k.name}</p>
                <p className="text-footnote text-muted">
                  {k.status === "imported" ? t("import.known.imported") : t("import.known.skippedBefore")}
                </p>
              </div>
              <Button variant="link" size="sm" onClick={() => onImportAnyway([k])}>
                {t("import.review.importAnyway")}
              </Button>
            </div>
          ))}
          {known.length > SHOWN && (
            <p className="p-3 text-footnote text-muted">{t("import.known.more", n(known.length - SHOWN))}</p>
          )}
        </Panel>
      )}
    </section>
  );
}
