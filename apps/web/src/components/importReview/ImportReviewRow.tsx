import type { ReactNode } from "react";
import SpeciesPicker, { type SpeciesResult } from "../SpeciesPicker";
import SuggestionCard from "../SuggestionCard";
import InlineSpinner from "../InlineSpinner";
import { visibleSuggestions, type ReviewRowBase } from "./useImportReview";

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
  onViewSpeciesGallery,
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
  /** This is the row the keyboard acts on, so its highlighted suggestion shows. */
  isActive: boolean;
  highlightIndex: number;
  onDismissWarning: (warning: "possibleDuplicate" | "notWildlife") => void;
  onViewSpeciesGallery: (speciesId: string, label: string) => void;
}) {
  const topIsCertain = row.suggestions.length > 0 && Math.round(row.suggestions[0].score * 100) >= 100;
  const shownSuggestions = visibleSuggestions(row.suggestions);

  return (
    <div data-import-row={row.key} className="p-3">
      <div className="flex items-center gap-3">
        <input type="checkbox" checked={selected} onChange={onToggleSelected} className="h-4 w-4" />
        {preview}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-ink">{name}</p>
          {focused ? (
            <div className="mt-1 w-64">
              <SpeciesPicker autoFocus placeholder="Type a species…" regionId={regionId} onSelect={onPick} />
            </div>
          ) : (
            <div className="mt-0.5 flex items-center gap-1.5">
              <button
                onClick={onFocus}
                title={row.speciesId ? "Click to change, or see other suggestions again" : undefined}
                className={`text-xs ${row.speciesId ? "text-ink" : "text-muted"} hover:underline`}
              >
                {row.speciesId ? row.speciesLabel : "Type a species…"}
              </button>
              {row.isInspecting && !row.speciesId && <InlineSpinner size="xs" label="Finding species suggestions" />}
              {!row.isInspecting && !row.speciesId && row.suggestError && (
                <span className="text-xs text-muted">{row.suggestError}. Pick a species by hand.</span>
              )}
            </div>
          )}
        </div>
        {status}
        {removable && (
          <button onClick={onRemove} title={removeLabel} aria-label="Remove" className="text-muted hover:text-ink">
            ✕
          </button>
        )}
      </div>
      {row.possibleDuplicate && (
        <div className="mt-2 ml-7 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          <span>
            {row.possibleDuplicate.exact
              ? "Looks like you've already imported this photo before. Do you want to import it anyway?"
              : "Looks like you've already imported a very similar photo (maybe edited or re-exported). Do you want to import it anyway?"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onRemove} className="font-medium underline">
              Remove
            </button>
            <button onClick={() => onDismissWarning("possibleDuplicate")} className="font-medium underline">
              Import anyway
            </button>
          </div>
        </div>
      )}
      {/* Suggestions wait until a duplicate or not-wildlife warning is dismissed. */}
      {row.notWildlife && !row.possibleDuplicate && (
        <div className="mt-2 ml-7 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          <span>This doesn't look like wildlife (it looks like {row.notWildlife.looksLike}), so it won't be imported.</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onRemove} className="font-medium underline">
              Remove
            </button>
            <button onClick={() => onDismissWarning("notWildlife")} className="font-medium underline">
              Import anyway
            </button>
          </div>
        </div>
      )}
      {!row.possibleDuplicate && !row.notWildlife && (!row.speciesId || focused) && shownSuggestions.length > 0 && (
        <div className="mt-2 pl-7">
          {/* Uses the margin-based `confident` flag; blended scores have no fixed cutoff. */}
          {!topIsCertain && row.suggestions.length > 1 && !row.suggestions[0]?.confident && (
            <p className="mb-1 text-xs text-muted">No confident match. Closest guesses:</p>
          )}
          {/* p-1 -m-1 keeps overflow-x-auto from clipping the highlighted card's ring. */}
          <div className="-m-1 flex gap-2 overflow-x-auto p-1">
            {shownSuggestions.map((s, si) => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                matchPercent={topIsCertain ? 100 : s.matchPercent ?? Math.round(s.score * 100)}
                highlighted={isActive && si === highlightIndex}
                onSelect={() => onPick(s)}
                onViewPhoto={() => onViewSpeciesGallery(s.id, s.common_name ?? s.scientific_name)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
