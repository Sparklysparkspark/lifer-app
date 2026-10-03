import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { SpeciesResult, SuggestedSpecies } from "../SpeciesPicker";
import type { PossibleDuplicate } from "../../lib/uploadQueue";

// What every species-review row has, wherever its photo came from: a file dropped on the import
// screen (PhotoImportRows) or one found by a trip scan (TripDetailPage).
export interface ReviewRowBase {
  key: string;
  speciesId: string | null;
  speciesLabel: string | null;
  suggestions: SuggestedSpecies[];
  /** Content match against an already-imported photo. `undefined` = not checked, `null` = none. */
  possibleDuplicate?: PossibleDuplicate | null;
  /** The photo shows no wildlife (species/wildlifeCheck.ts): left out unless "Import anyway". */
  notWildlife?: { looksLike: string } | null;
  /** Suggestions are being worked out: a spinner instead of "no suggestions". */
  isInspecting?: boolean;
  /** Suggestions couldn't be computed at all, so the row doesn't read as "no species matched". */
  suggestError?: string;
}

/** Selection, bulk and one-at-a-time assignment, and the keyboard flow of a species review:
 * Left/Right move the highlighted suggestion, Enter assigns and moves on, Up reopens the previous
 * row, and Enter with every row assigned calls `onAllAssignedEnter`. Ignored while a text field has focus. */
/** The suggestions a row shows: only the top one when it's certain or confidently ahead. */
export function visibleSuggestions<T extends { score: number; confident?: boolean }>(suggestions: T[]): T[] {
  const topIsCertain = suggestions.length > 0 && Math.round(suggestions[0].score * 100) >= 100;
  return topIsCertain || suggestions[0]?.confident ? suggestions.slice(0, 1) : suggestions;
}

export function useImportReview<R extends ReviewRowBase>(
  rows: R[],
  setRows: Dispatch<SetStateAction<R[]>>,
  opts: { onAllAssignedEnter?: () => void; enterStartsImport: boolean },
) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);

  // Set when a row was just assigned (or reopened with Up), so the next row to do is scrolled into view.
  const scrollToActiveRow = useRef(false);

  function assignSpecies(keys: string[], result: SpeciesResult) {
    setRows((prev) =>
      prev.map((r) =>
        // Picking a species by hand overrides a "doesn't look like wildlife" flag.
        keys.includes(r.key) ? { ...r, speciesId: result.id, speciesLabel: result.common_name ?? result.scientific_name, notWildlife: null } : r,
      ),
    );
    // Assigned rows get checked, which shows progress and pre-selects them for bulk actions.
    setSelected((prev) => new Set([...prev, ...keys]));
  }

  // The next unassigned row's top suggestion gets highlighted, so Enter keeps the batch moving.
  function assignAndAdvance(key: string, result: SpeciesResult) {
    assignSpecies([key], result);
    setFocusedRowKey(null);
    scrollToActiveRow.current = true;
  }

  function toggleSelected(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Forgets a removed row's selection and focus. */
  function forgetRow(key: string) {
    setSelected((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (focusedRowKey === key) setFocusedRowKey(null);
  }

  /** "Import anyway" on a duplicate or not-wildlife warning. */
  function dismissWarning(key: string, warning: "possibleDuplicate" | "notWildlife") {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [warning]: null } : r)));
  }

  // Keyboard actions target the first unassigned row; not-wildlife rows are skipped.
  const activeRow = rows.find((r) => !r.speciesId && !r.notWildlife);
  const [highlightIndex, setHighlightIndex] = useState(0);
  useEffect(() => {
    setHighlightIndex(0);
  }, [activeRow?.key]);
  useEffect(() => {
    if (!scrollToActiveRow.current || !activeRow) return;
    scrollToActiveRow.current = false;
    document.querySelector(`[data-import-row="${CSS.escape(activeRow.key)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeRow?.key]);

  // Up undoes a stray Enter: reopens the previous assigned row with its pick still highlighted.
  function goBackToPreviousRow() {
    const activeIdx = activeRow ? rows.findIndex((r) => r.key === activeRow.key) : rows.length;
    for (let i = activeIdx - 1; i >= 0; i--) {
      const row = rows[i];
      if (!row.speciesId) continue;
      const prevIndex = row.suggestions.findIndex((s) => s.id === row.speciesId);
      setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, speciesId: null, speciesLabel: null } : r)));
      setSelected((prev) => {
        if (!prev.has(row.key)) return prev;
        const next = new Set(prev);
        next.delete(row.key);
        return next;
      });
      setHighlightIndex(prevIndex >= 0 ? prevIndex : 0);
      scrollToActiveRow.current = true;
      return;
    }
  }

  const { onAllAssignedEnter, enterStartsImport } = opts;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        goBackToPreviousRow();
        return;
      }
      if (!activeRow) {
        // Every row assigned: Enter starts the import.
        if (e.key === "Enter" && enterStartsImport && onAllAssignedEnter) {
          e.preventDefault();
          onAllAssignedEnter();
        }
        return;
      }
      // Only what's on screen: a confident top match hides the rest.
      const shown = visibleSuggestions(activeRow.suggestions);
      if (shown.length === 0) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((i) => Math.min(i + 1, shown.length - 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = shown[highlightIndex];
        if (pick) assignAndAdvance(activeRow.key, pick);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRow, highlightIndex, enterStartsImport, onAllAssignedEnter, rows]);

  return {
    selected,
    setSelected,
    toggleSelected,
    focusedRowKey,
    setFocusedRowKey,
    activeRow,
    highlightIndex,
    assignSpecies,
    assignAndAdvance,
    forgetRow,
    dismissWarning,
  };
}
