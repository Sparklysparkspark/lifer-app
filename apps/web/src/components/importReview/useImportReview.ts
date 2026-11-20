import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useLatest } from "../../hooks/useLatest";
import { isTypingTarget } from "../../hooks/useKeyboardShortcuts";
import { matches } from "../../lib/keymap";
import type { SpeciesResult, SuggestedSpecies } from "../SpeciesPicker";
import type { PossibleDuplicate } from "../../lib/uploadQueue";
import type { CullMarks } from "@lifer/shared";
import { useSpeciesName } from "../../lib/speciesName";
import { nextToConfirm } from "./compareQueue";

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
  notWildlife?: { looksLike: string; marked?: boolean } | null;
  /** Probably not wildlife, short of the flag: the row asks, and is never left out on its own. */
  maybeNotWildlife?: { looksLike: string; share: number } | null;
  /** A RAW of a photo already imported: it's filed with that photo, so its species is set. */
  rawMatch?: { captureId: string; speciesName: string } | null;
  /** An insect, spider or the like (wildlifeCheck.ts), which the checklists rarely cover. */
  invertebrate?: { looksLike: string } | null;
  /** Suggestions are being worked out: a spinner instead of "no suggestions". */
  isInspecting?: boolean;
  /** Suggestions couldn't be computed at all, so the row doesn't read as "no species matched". */
  suggestError?: string;
  /** What a culling app marked the photo (CullMarksChoice). `undefined` = not read yet. */
  cull?: CullMarks | null;
  /** The animal's box in percent of the shown photo, which compare mode opens zoomed on. */
  subject?: { x: number; y: number; w: number; h: number } | null;
}

/** Compare mode's opening state: the photo, the ticked photos it confirms with, a species to show first. */
export interface CompareTarget {
  key: string;
  group: string[] | null;
  speciesId?: string;
}

/** The suggestions a row shows: only the top one when it's certain or confidently ahead. */
export function visibleSuggestions<T extends { score: number; confident?: boolean }>(suggestions: T[]): T[] {
  const topIsCertain = suggestions.length > 0 && Math.round(suggestions[0].score * 100) >= 100;
  return topIsCertain || suggestions[0]?.confident ? suggestions.slice(0, 1) : suggestions;
}

/** Selection, bulk and one-at-a-time assignment, and the keyboard flow of a species review:
 * Up and Down move between photos and never confirm, Left/Right or 1 to 5 move the highlighted
 * suggestion, Enter confirms it and moves on, Backspace clears a species, Mod+Z undoes the last
 * confirm or clear, and Enter with every row assigned calls `onAllAssignedEnter`; C opens compare
 * mode. Ignored while a text field or compare has focus. */
export function useImportReview<R extends ReviewRowBase>(
  rows: R[],
  setRows: Dispatch<SetStateAction<R[]>>,
  opts: { onAllAssignedEnter?: () => void; enterStartsImport: boolean },
) {
  const speciesName = useSpeciesName();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  // The photo Up and Down moved to; null follows the first photo without a species.
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  // Compare mode owns the keyboard while it's open.
  const [compare, setCompare] = useState<CompareTarget | null>(null);

  // Set when a row was just assigned (or reopened with Up), so the next row to do is scrolled into view.
  const scrollToActiveRow = useRef(false);

  function assignSpecies(keys: string[], result: SpeciesResult) {
    setRows((prev) =>
      prev.map((r) =>
        // Picking a species by hand overrides a "doesn't look like wildlife" flag.
        keys.includes(r.key)
          ? {
              ...r,
              speciesId: result.id,
              speciesLabel: speciesName(result),
              notWildlife: null,
            }
          : r,
      ),
    );
    // Assigned rows get checked, which shows progress and pre-selects them for bulk actions.
    setSelected((prev) => new Set([...prev, ...keys]));
  }

  // Mod+Z takes back the last confirm or clear: each entry is the row's species before it.
  // One step per action, covering every photo it changed (a set marked "no animal" at once).
  type Before = Pick<ReviewRowBase, "key" | "speciesId" | "speciesLabel" | "notWildlife" | "maybeNotWildlife">;
  const undoStack = useRef<Before[][]>([]);
  const remember = (keys: string[]) => {
    const step = rows
      .filter((r) => keys.includes(r.key))
      .map((r) => ({
        key: r.key,
        speciesId: r.speciesId,
        speciesLabel: r.speciesLabel,
        notWildlife: r.notWildlife,
        maybeNotWildlife: r.maybeNotWildlife,
      }));
    if (step.length) undoStack.current.push(step);
  };

  // Confirms and moves on to the next photo still without a species, its top suggestion highlighted.
  function assignAndAdvance(key: string, result: SpeciesResult) {
    remember([key]);
    assignSpecies([key], result);
    setFocusedRowKey(null);
    setCursorKey(nextToConfirm(rows, key, [key]));
    scrollToActiveRow.current = true;
  }

  function undoLast() {
    const step = undoStack.current.pop();
    if (!step) return;
    const before = new Map(step.map((e) => [e.key, e]));
    setRows((prev) => prev.map((r) => (before.has(r.key) ? { ...r, ...before.get(r.key)! } : r)));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const e of step) {
        if (e.speciesId) next.add(e.key);
        else next.delete(e.key);
      }
      return next;
    });
    // Back on the photo, a taken-back pick highlighted so Enter puts it back.
    const first = step[0];
    const row = rows.find((r) => r.key === first.key);
    setCursorKey(first.key);
    if (!first.speciesId && row?.speciesId) {
      setHighlightFor(first.key);
      setHighlightIndex(
        Math.max(
          visibleSuggestions(row.suggestions).findIndex((x) => x.id === row.speciesId),
          0,
        ),
      );
    }
    scrollToActiveRow.current = true;
  }

  /** "No animal": the photos are left out like ones that don't look like wildlife (the row's
   *  "Import anyway" brings one back, Mod+Z the whole step), and the keys move on. */
  function markNoAnimal(keys: string[]) {
    remember(keys);
    setRows((prev) =>
      prev.map((r) =>
        keys.includes(r.key)
          ? {
              ...r,
              speciesId: null,
              speciesLabel: null,
              notWildlife: { looksLike: r.maybeNotWildlife?.looksLike ?? "", marked: true },
              maybeNotWildlife: null,
            }
          : r,
      ),
    );
    setSelected((prev) => new Set([...prev].filter((k) => !keys.includes(k))));
    setFocusedRowKey(null);
    setCursorKey(nextToConfirm(rows, keys[keys.length - 1], keys));
    scrollToActiveRow.current = true;
  }

  // Backspace: the photo goes back to its suggestions, its pick highlighted, undoably.
  function clearSpecies(row: R) {
    if (!row.speciesId || row.rawMatch) return;
    remember([row.key]);
    reopen(row);
  }

  // Clears a row's species and unticks it, keeping its pick highlighted so Enter puts it back.
  function reopen(row: R) {
    const pick = visibleSuggestions(row.suggestions).findIndex((s) => s.id === row.speciesId);
    setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, speciesId: null, speciesLabel: null } : r)));
    setSelected((prev) => {
      if (!prev.has(row.key)) return prev;
      const next = new Set(prev);
      next.delete(row.key);
      return next;
    });
    setHighlightFor(row.key);
    setHighlightIndex(Math.max(pick, 0));
  }

  function toggleSelected(key: string) {
    // A tick means confirmed, so unticking a confirmed photo reopens its suggestions.
    const row = rows.find((r) => r.key === key);
    if (row?.speciesId && !row.rawMatch && selected.has(key)) {
      reopen(row);
      setCursorKey(key);
      return;
    }
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
    if (cursorKey === key) setCursorKey(null);
  }

  /** "Import anyway" on a duplicate or not-wildlife warning. A duplicate's earlier photo is the best
   *  match there is, so its species is filled in (unless one was already picked). */
  function dismissWarning(key: string, warning: "possibleDuplicate" | "notWildlife" | "maybeNotWildlife") {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const dup = warning === "possibleDuplicate" ? r.possibleDuplicate : null;
        return {
          ...r,
          [warning]: null,
          ...(dup && !r.speciesId ? { speciesId: dup.speciesId, speciesLabel: speciesName(dup) } : {}),
        };
      }),
    );
  }

  // Keyboard actions target the cursor row, else the first unassigned row; not-wildlife rows are skipped.
  const activeRow = rows.find((r) => r.key === cursorKey) ?? rows.find((r) => !r.speciesId && !r.notWildlife);
  const activeKey = activeRow?.key;
  // A new active row starts at its first suggestion.
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [highlightFor, setHighlightFor] = useState(activeKey);
  if (highlightFor !== activeKey) {
    setHighlightFor(activeKey);
    setHighlightIndex(0);
  }
  useEffect(() => {
    if (!scrollToActiveRow.current || !activeKey) return;
    scrollToActiveRow.current = false;
    document
      .querySelector(`[data-import-row="${CSS.escape(activeKey)}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeKey]);

  function moveCursor(step: 1 | -1) {
    const from = activeRow ? rows.indexOf(activeRow) : step > 0 ? -1 : rows.length;
    const next = rows[Math.min(Math.max(from + step, 0), rows.length - 1)];
    if (!next) return;
    setCursorKey(next.key);
    scrollToActiveRow.current = true;
  }

  // Ticks on confirmed rows mean "confirmed", so bulk assign acts only on the ones still to do.
  const bulkKeys = rows.filter((r) => selected.has(r.key) && !r.speciesId).map((r) => r.key);

  // A ticked photo compares with the rest of the ticked ones still to confirm, as one set.
  function openCompare(key: string, speciesId?: string) {
    const group = bulkKeys.includes(key) && bulkKeys.length > 1 ? bulkKeys : null;
    setCompare({ key, group, speciesId });
  }

  const { onAllAssignedEnter, enterStartsImport } = opts;
  // The key handler outlives renders; these keep it calling the current versions.
  const assignRef = useLatest(assignAndAdvance);
  const undoRef = useLatest(undoLast);
  const clearRef = useLatest(clearSpecies);
  const noAnimalRef = useLatest(markNoAnimal);
  const moveRef = useLatest(moveCursor);
  const openCompareRef = useLatest(openCompare);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (compare || isTypingTarget(e.target)) return;
      if (matches(e, "compareImport") && activeRow) {
        e.preventDefault();
        openCompareRef.current(activeRow.key);
        return;
      }
      // Only what's on screen: a confident top match hides the rest.
      const pickable = activeRow && !activeRow.speciesId && !activeRow.notWildlife;
      const shown = pickable ? visibleSuggestions(activeRow.suggestions) : [];
      // Up and Down only move between photos: leaving one never confirms its highlighted suggestion.
      if (matches(e, "previousGroup") || matches(e, "nextGroup")) {
        e.preventDefault();
        moveRef.current(matches(e, "nextGroup") ? 1 : -1);
        return;
      }
      if (matches(e, "importUndo")) {
        e.preventDefault();
        undoRef.current();
        return;
      }
      if (matches(e, "importNoAnimal") && activeRow && !activeRow.notWildlife) {
        e.preventDefault();
        noAnimalRef.current([activeRow.key]);
        return;
      }
      if (matches(e, "importClear") && activeRow?.speciesId) {
        e.preventDefault();
        clearRef.current(activeRow);
        return;
      }
      if (!activeRow) {
        // Every row assigned: Enter starts the import.
        if (matches(e, "confirm") && enterStartsImport && onAllAssignedEnter) {
          e.preventDefault();
          onAllAssignedEnter();
        }
        return;
      }
      if (shown.length === 0) {
        // Nothing to pick on this photo: Enter opens its species box.
        if (matches(e, "confirm")) {
          e.preventDefault();
          setFocusedRowKey(activeRow.key);
        }
        return;
      }
      if (matches(e, "next")) {
        e.preventDefault();
        setHighlightIndex((i) => Math.min(i + 1, shown.length - 1));
      } else if (matches(e, "previous")) {
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
      } else if (matches(e, "compareSpecies")) {
        const n = Number(e.code.slice(-1)) - 1;
        if (n < shown.length) {
          e.preventDefault();
          setHighlightIndex(n);
        }
      } else if (matches(e, "confirm")) {
        e.preventDefault();
        const pick = shown[highlightIndex];
        if (pick) assignRef.current(activeRow.key, pick);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    compare,
    activeRow,
    cursorKey,
    highlightIndex,
    enterStartsImport,
    onAllAssignedEnter,
    assignRef,
    undoRef,
    clearRef,
    noAnimalRef,
    moveRef,
    openCompareRef,
  ]);

  return {
    selected,
    setSelected,
    bulkKeys,
    toggleSelected,
    focusedRowKey,
    setFocusedRowKey,
    activeRow,
    highlightIndex,
    assignSpecies,
    assignAndAdvance,
    forgetRow,
    dismissWarning,
    markNoAnimal,
    compare,
    openCompare,
    closeCompare: () => setCompare(null),
  };
}
