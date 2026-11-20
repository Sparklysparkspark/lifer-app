import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import SpeciesPicker, { type SpeciesResult } from "../SpeciesPicker";
import SuggestionCard from "../SuggestionCard";
import InlineSpinner from "../InlineSpinner";
import InvertebrateHint from "./InvertebrateHint";
import ProbableGroupText from "../ProbableGroupText";
import { visibleSuggestions, type ReviewRowBase } from "./useImportReview";
import { useSpeciesName } from "../../lib/speciesName";
import { formatDate } from "../../lib/format";
import Button, { IconButton } from "../Button";
import Checkbox from "../Checkbox";
import { shortcutLabel } from "../../lib/keymap";

// One photo in a species review (import screen and trip review): preview, picked species, warnings
// and suggestion cards. The preview and status come from the caller.
export default function ImportReviewRow({
  row,
  name,
  preview,
  status,
  removable,
  onRemove,
  removeLabel,
  selected,
  onToggleSelected,
  focused,
  onFocus,
  regionId,
  onPick,
  isActive,
  highlightIndex,
  onDismissWarning,
  onCompare,
  onNoAnimal,
}: {
  row: ReviewRowBase;
  name: string;
  preview: ReactNode;
  status?: ReactNode;
  removable: boolean;
  onRemove: () => void;
  /** Title of the ✕ button, e.g. "Remove this photo from the import list". */
  removeLabel: string;
  selected: boolean;
  onToggleSelected: () => void;
  focused: boolean;
  onFocus: () => void;
  regionId: string | null;
  onPick: (result: SpeciesResult) => void;
  /** This is the row the keyboard acts on: outlined, and its highlighted suggestion shows. */
  isActive: boolean;
  highlightIndex: number;
  onDismissWarning: (warning: "possibleDuplicate" | "notWildlife" | "maybeNotWildlife") => void;
  /** Opens compare mode on this photo, showing `speciesId` first when given. */
  onCompare: (speciesId?: string) => void;
  /** Leaves the photo out as having no animal in it (Mod+Z takes it back). */
  onNoAnimal?: () => void;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const topIsCertain = row.suggestions.length > 0 && Math.round(row.suggestions[0].score * 100) >= 100;
  const shownSuggestions = visibleSuggestions(row.suggestions);
  const dismissDuplicate = () => onDismissWarning("possibleDuplicate");
  const dismissNotWildlife = () => onDismissWarning("notWildlife");
  const keepMaybe = () => onDismissWarning("maybeNotWildlife");

  return (
    <div
      data-import-row={row.key}
      className={`p-3 first:rounded-t-panel last:rounded-b-panel ${isActive ? "ring-2 ring-inset ring-accent" : ""}`}
    >
      {/* Wraps at narrow widths, so the status moves under the name instead of over it. */}
      <div className="flex flex-wrap items-center gap-3">
        <Checkbox checked={selected} onChange={onToggleSelected} aria-label={name} />
        {preview}
        <div className="min-w-0 flex-1 basis-40">
          <p className="truncate text-callout text-ink">{name}</p>
          {focused ? (
            <div className="mt-1 w-64">
              <SpeciesPicker
                autoFocus
                placeholder={t("import.rows.typeSpecies")}
                regionId={regionId}
                onSelect={onPick}
              />
            </div>
          ) : (
            <div className="mt-0.5 flex items-center gap-1.5">
              <Button
                variant="link"
                size="sm"
                onClick={onFocus}
                tooltip={row.speciesId ? { label: t("import.review.changeSpecies") } : undefined}
                className={row.speciesId ? "text-ink!" : ""}
              >
                {row.speciesId ? row.speciesLabel : t("import.rows.typeSpecies")}
              </Button>
              {row.isInspecting && !row.speciesId && (
                <InlineSpinner size="xs" label={t("import.review.findingSuggestions")} />
              )}
              {!row.notWildlife && !row.possibleDuplicate && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => onCompare()}
                  tooltip={{ label: t("import.review.compareTip"), shortcut: shortcutLabel("compareImport") }}
                >
                  {t("import.review.compare")}
                </Button>
              )}
              {onNoAnimal && !row.notWildlife && !row.possibleDuplicate && !row.speciesId && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={onNoAnimal}
                  tooltip={{ label: t("import.review.noAnimalTip"), shortcut: shortcutLabel("importNoAnimal") }}
                >
                  {t("import.review.noAnimal")}
                </Button>
              )}
              {row.rawMatch && <span className="text-footnote text-muted">{t("import.review.rawMatch")}</span>}
              {!row.isInspecting && !row.speciesId && row.suggestError && (
                <span className="text-footnote text-muted">
                  {t("import.review.suggestError", { error: row.suggestError })}
                </span>
              )}
            </div>
          )}
        </div>
        {status && <div className="ml-auto flex min-w-0 flex-wrap items-center gap-3">{status}</div>}
        {removable && (
          <IconButton
            tone="plain"
            onClick={onRemove}
            tooltip={{ label: removeLabel }}
            aria-label={t("import.review.remove")}
          >
            ✕
          </IconButton>
        )}
      </div>
      {row.possibleDuplicate && (
        <div className="mt-2 ml-7 flex items-center gap-2 rounded-control border border-amber-200 bg-amber-50 px-2 py-1.5 text-footnote text-amber-800">
          {/* The earlier photo, so the two can be compared before deciding. */}
          {row.possibleDuplicate.photoId && (
            <img
              src={`/api/photos/${row.possibleDuplicate.photoId}/thumb`}
              alt={t("import.review.earlierPhoto", { species: speciesName(row.possibleDuplicate) })}
              className="h-12 w-12 shrink-0 rounded-badge object-cover"
            />
          )}
          <span>
            {t(row.possibleDuplicate.exact ? "import.review.duplicateExact" : "import.review.duplicateSimilar", {
              species: speciesName(row.possibleDuplicate),
              dated: row.possibleDuplicate.takenAt ? "yes" : "no",
              date: row.possibleDuplicate.takenAt ? formatDate(row.possibleDuplicate.takenAt) : "",
            })}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="link" size="sm" onClick={onRemove} className="font-medium text-current! underline">
              {t("import.review.remove")}
            </Button>
            <Button variant="link" size="sm" onClick={dismissDuplicate} className="font-medium text-current! underline">
              {t("import.review.importAnyway")}
            </Button>
          </div>
        </div>
      )}
      {/* Suggestions wait until a duplicate or not-wildlife warning is dismissed. */}
      {row.notWildlife && !row.possibleDuplicate && (
        <div className="mt-2 ml-7 flex items-center gap-2 rounded-control border border-amber-200 bg-amber-50 px-2 py-1.5 text-footnote text-amber-800">
          <span>
            {row.notWildlife.marked
              ? t("import.review.noAnimalMarked")
              : t("import.review.notWildlife", { looksLike: row.notWildlife.looksLike })}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="link" size="sm" onClick={onRemove} className="font-medium text-current! underline">
              {t("import.review.remove")}
            </Button>
            <Button
              variant="link"
              size="sm"
              onClick={dismissNotWildlife}
              className="font-medium text-current! underline"
            >
              {t("import.review.importAnyway")}
            </Button>
          </div>
        </div>
      )}
      {/* A "maybe" stays in the list with a quiet question: hiding a real animal would be worse. */}
      {row.maybeNotWildlife && !row.notWildlife && !row.possibleDuplicate && !row.speciesId && (
        <div className="mt-2 ml-7 flex flex-wrap items-center gap-x-3 gap-y-1 text-footnote text-muted">
          <span>{t("import.review.maybeNote", { looksLike: row.maybeNotWildlife.looksLike })}</span>
          {onNoAnimal && (
            <Button
              variant="link"
              size="sm"
              onClick={onNoAnimal}
              tooltip={{ label: t("import.review.noAnimalTip"), shortcut: shortcutLabel("importNoAnimal") }}
            >
              {t("import.review.noAnimal")}
            </Button>
          )}
          <Button variant="link" size="sm" onClick={keepMaybe}>
            {t("import.review.keep")}
          </Button>
        </div>
      )}
      {row.invertebrate && !row.possibleDuplicate && !row.notWildlife && !row.speciesId && (
        <InvertebrateHint looksLike={row.invertebrate.looksLike} regionId={regionId} onPick={onPick} />
      )}
      {!row.possibleDuplicate && !row.notWildlife && (!row.speciesId || focused) && shownSuggestions.length > 0 && (
        <div className="mt-2 pl-7">
          {/* Uses the margin-based `confident` flag; blended scores have no fixed cutoff. */}
          {!topIsCertain && row.suggestions.length > 1 && !row.suggestions[0]?.confident && (
            <p className="mb-1 text-footnote text-muted wrap-anywhere">
              {row.suggestions[0].probably ? (
                <ProbableGroupText group={row.suggestions[0].probably} />
              ) : (
                t("import.review.noConfidentMatch")
              )}
            </p>
          )}
          {/* p-1 -m-1 keeps overflow-x-auto from clipping the highlighted card's ring. */}
          <div className="-m-1 flex gap-2 overflow-x-auto p-1">
            {shownSuggestions.map((s, si) => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                matchPercent={topIsCertain ? 100 : (s.matchPercent ?? Math.round(s.score * 100))}
                highlighted={isActive && si === highlightIndex}
                onSelect={() => onPick(s)}
                onViewPhoto={() => onCompare(s.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
