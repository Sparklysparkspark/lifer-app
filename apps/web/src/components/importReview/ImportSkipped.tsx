import { useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "../Button";
import Panel from "../Panel";
import { Chevron } from "../GroupedSpeciesGrid";
import { formatDate, formatNumber } from "../../lib/format";
import { useSpeciesName } from "../../lib/speciesName";
import type { ReviewRowBase } from "./useImportReview";
import { skipKind, type SkipKind } from "./compareQueue";

// Exact copies and look-alikes are both "duplicate", but only the first are really in Lifer already.
type Section = SkipKind | "similar";
const SECTIONS: Section[] = ["notWildlife", "marked", "duplicate", "similar"];
const sectionOf = (row: ReviewRowBase): Section | null => {
  const kind = skipKind(row);
  return kind === "duplicate" && !row.possibleDuplicate?.exact ? "similar" : kind;
};

// Photos this import leaves out, kept out of the review list in one folded section at its end and
// split by why, so they never get in the way of the ones to name. A verdict that arrives late moves
// a row here without the rows the user is on moving. "Import anyway" puts one back in the list
// (a duplicate filed under its earlier species).
export default function ImportSkipped<R extends ReviewRowBase>({
  rows,
  nameOf,
  thumb,
  onRemove,
  onImportAnyway,
  onOpen,
}: {
  /** Rows `skipKind` gives a kind. */
  rows: R[];
  nameOf: (row: R) => string;
  thumb: (row: R) => string | null;
  onRemove: (keys: string[]) => void;
  onImportAnyway: (keys: string[]) => void;
  /** Opens the photo full size. */
  onOpen?: (row: R) => void;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  const keys = rows.map((r) => r.key);
  const count = (n: number) => ({ count: n, formatted: formatNumber(n) });
  const title = t("import.skipped.title", count(rows.length));
  const headings: Record<Section, (n: number) => string> = {
    notWildlife: (n) => t("import.skipped.notWildlife", count(n)),
    marked: (n) => t("import.skipped.marked", count(n)),
    duplicate: (n) => t("import.skipped.duplicates", count(n)),
    similar: (n) => t("import.skipped.similar", count(n)),
  };
  const why = (row: R): string => {
    const dup = row.possibleDuplicate;
    if (dup)
      return dup.takenAt
        ? t("import.skipped.asSpeciesOn", { species: speciesName(dup), date: formatDate(dup.takenAt) })
        : t("import.skipped.asSpecies", { species: speciesName(dup) });
    return row.notWildlife?.marked
      ? t("import.skipped.markedNote")
      : t("import.skipped.looksLike", { looksLike: row.notWildlife?.looksLike ?? "" });
  };

  return (
    <section aria-label={title} data-import-skipped>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* raw-control: the section's heading is its disclosure, as for the import's groups. */}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 items-center gap-2 text-left text-callout font-medium text-ink hover:underline"
        >
          <Chevron open={open} />
          <span className="min-w-0 break-words">{title}</span>
        </button>
        {open && (
          <div className="ml-auto flex items-center gap-3">
            <Button variant="link" size="sm" onClick={() => onRemove(keys)}>
              {t("import.skipped.removeAll")}
            </Button>
            <Button variant="link" size="sm" onClick={() => onImportAnyway(keys)}>
              {t("import.skipped.importAll")}
            </Button>
          </div>
        )}
      </div>
      {open &&
        SECTIONS.map((kind) => {
          const these = rows.filter((r) => sectionOf(r) === kind);
          if (these.length === 0) return null;
          return (
            <div key={kind} className="mt-3" data-skip-kind={kind}>
              <h3 className="mb-1 text-footnote font-medium text-muted">{headings[kind](these.length)}</h3>
              <Panel grouped>
                {these.map((row) => {
                  const src = thumb(row);
                  return (
                    // A late arrival fades in rather than appearing with a jump.
                    <div
                      key={row.key}
                      data-skipped-row={row.key}
                      className="flex flex-wrap items-center gap-3 p-3 motion-safe:transition-opacity motion-safe:duration-300 motion-safe:starting:opacity-0"
                    >
                      {/* raw-control: the thumbnail opens the photo full size, as the review rows do. */}
                      <button
                        type="button"
                        aria-label={nameOf(row)}
                        disabled={!onOpen}
                        onClick={() => onOpen?.(row)}
                        className="shrink-0 rounded-badge focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {src ? (
                          <img src={src} alt="" className="block h-10 w-10 rounded-badge object-cover" />
                        ) : (
                          <span className="block h-10 w-10 rounded-badge bg-surface-muted" />
                        )}
                      </button>
                      <div className="min-w-0 flex-1 basis-48">
                        <p className="text-callout text-ink wrap-anywhere">{nameOf(row)}</p>
                        <p className="text-footnote text-muted wrap-anywhere">{why(row)}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <Button variant="link" size="sm" onClick={() => onRemove([row.key])}>
                          {t("import.skipped.remove")}
                        </Button>
                        <Button variant="link" size="sm" onClick={() => onImportAnyway([row.key])}>
                          {t("import.review.importAnyway")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </Panel>
            </div>
          );
        })}
    </section>
  );
}
