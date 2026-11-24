import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Button from "../Button";
import Panel from "../Panel";
import ProgressBar from "../ProgressBar";
import { formatNumber } from "../../lib/format";
import { useSpeciesName } from "../../lib/speciesName";
import type { KnownFile } from "../../lib/knownFiles";

// Long lists stay quick: the rest are still covered by "Import all anyway".
const SHOWN = 300;

// Picked files the library already has, or that were left out before, are never uploaded or
// checked. The first line after a pick says how many are already in Lifer; "Show them" lists them,
// the ones in the library with the photo each became, apart from the ones skipped earlier.
export default function KnownFiles({
  known,
  fresh,
  edited,
  checking,
  onImportAnyway,
  clear,
}: {
  known: KnownFile[];
  /** New files from the same picks. */
  fresh: number;
  /** New files that look like edited copies of imported photos. */
  edited: number;
  /** Files fingerprinted so far, while a big pick is still being sorted. */
  checking: { done: number; total: number } | null;
  onImportAnyway: (files: KnownFile[]) => void;
  /** "Clear out the ones already in Lifer", where the files' own folder is reachable. */
  clear?: ReactNode;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const [open, setOpen] = useState(false);
  if (known.length === 0 && edited === 0 && !checking) return null;
  const n = (count: number) => ({ count, formatted: formatNumber(count) });
  const inLifer = known.filter((k) => k.status === "imported");
  const skipped = known.filter((k) => k.status === "skipped");
  const total = known.length + fresh;
  const summary = [
    inLifer.length > 0 ? t("import.known.inLifer", { ...n(inLifer.length), total: formatNumber(total) }) : null,
    skipped.length > 0 ? t("import.known.skippedCount", n(skipped.length)) : null,
    known.length > 0 ? t("import.known.newCount", n(fresh)) : null,
  ].filter(Boolean);

  const list = (files: KnownFile[], title: string, shown: number) =>
    files.length > 0 &&
    shown > 0 && (
      <section className="space-y-1">
        <h3 className="text-footnote font-medium text-muted">{title}</h3>
        <Panel grouped>
          {files.slice(0, shown).map((k, i) => (
            <div key={k.path ?? `${i}-${k.name}`} className="flex flex-wrap items-center gap-3 p-3" data-known-row>
              {k.match?.photoId && (
                <img
                  src={`/api/photos/${k.match.photoId}/thumb`}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-badge object-cover"
                />
              )}
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-callout text-ink wrap-anywhere">{k.name}</p>
                <p className="text-footnote text-muted">
                  {k.status === "skipped"
                    ? t("import.known.skippedBefore")
                    : k.match
                      ? t("import.known.inLiferAs", { species: speciesName(k.match) })
                      : t("import.known.imported")}
                </p>
              </div>
              <Button variant="link" size="sm" onClick={() => onImportAnyway([k])}>
                {t("import.review.importAnyway")}
              </Button>
            </div>
          ))}
        </Panel>
      </section>
    );

  return (
    <section className="space-y-2" data-known-files>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-callout">
        {known.length > 0 && <span className="font-medium text-ink">{summary.join(", ")}</span>}
        {edited > 0 && <span className="text-muted">{t("import.known.edited", n(edited))}</span>}
        {known.length > 0 && (
          <Button variant="link" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? t("import.known.hide") : t("import.known.show")}
          </Button>
        )}
        {clear}
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
      {open && (
        <>
          {list(inLifer, t("import.known.inLiferTitle", n(inLifer.length)), SHOWN)}
          {list(skipped, t("import.known.skippedTitle", n(skipped.length)), SHOWN - Math.min(SHOWN, inLifer.length))}
          {known.length > SHOWN && (
            <p className="text-footnote text-muted">{t("import.known.more", n(known.length - SHOWN))}</p>
          )}
        </>
      )}
    </section>
  );
}
