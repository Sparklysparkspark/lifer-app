import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { SEARCH_DEBOUNCE_MS } from "../lib/searchNormalize";
import AddOtherTaxaModal from "./AddOtherTaxaModal";
import SearchInput from "./SearchInput";

export interface SpeciesResult {
  id: string;
  scientific_name: string;
  common_name: string | null;
}

export interface SuggestedSpecies extends SpeciesResult {
  /** Blended image+text match score, 0-1. */
  score: number;
  /** Only on the top suggestion when it clears the margin-over-runner-up rule (embeddings.ts
   *  markConfidence). Use this, not a raw score, to decide on a "no confident match" caption. */
  confident?: boolean;
  /** 0-100: show this, not `Math.round(score * 100)` (see embeddings.ts assignDisplayPercents). */
  matchPercent?: number;
  /** What it matched on; "keyword_tag" is a species named in the photo's own keywords. */
  source?: string;
}

// Fuzzy species search, recent species when empty. With onSelect it assigns inline (bulk import,
// ID correction); without it, it jumps to the species page and offers the iNaturalist fallback.
export default function SpeciesPicker({
  onSelect,
  autoFocus,
  placeholder,
  regionId,
}: {
  onSelect?: (r: SpeciesResult) => void;
  autoFocus?: boolean;
  placeholder?: string;
  /** Ranks this region's checklist first. */
  regionId?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SpeciesResult[]>([]);
  // The query `results` answer, so Enter never picks from an older query's list.
  const [resultsFor, setResultsFor] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [anyTaxaSearchEnabled, setAnyTaxaSearchEnabled] = useState(false);
  const [otherTaxaModalOpen, setOtherTaxaModalOpen] = useState(false);
  const navigate = useNavigate();
  const listId = useId();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Enter pressed before the current query's results arrived: pick the top one when they do.
  const enterPendingRef = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // The bulk-import picker already has a region for the whole batch, so no per-row iNat fallback.
  useEffect(() => {
    if (onSelect) return;
    api
      .get<{ anyTaxaSearchEnabled: boolean }>("/settings")
      .then((res) => setAnyTaxaSearchEnabled(res.anyTaxaSearchEnabled))
      .catch(() => {});
  }, [onSelect]);

  function fetchResults(q: string) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const params = new URLSearchParams({ q });
    if (regionId) params.set("regionId", regionId);
    api
      .get<{ results: SpeciesResult[] }>(`/species?${params}`, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setResults(res.results);
        setResultsFor(q);
        setHighlighted(0);
        if (enterPendingRef.current) {
          enterPendingRef.current = false;
          if (res.results[0]) selectResult(res.results[0]);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) enterPendingRef.current = false;
      });
  }
  const fetchRef = useRef(fetchResults);
  fetchRef.current = fetchResults;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    debounceRef.current = setTimeout(() => fetchRef.current(q), SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, regionId]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    },
    [],
  );

  const showInatRow = !onSelect && anyTaxaSearchEnabled && query.trim().length >= 2;
  const optionCount = results.length + (showInatRow ? 1 : 0);
  // Clamped so a shorter result list never leaves the highlight past the end.
  const active = optionCount === 0 ? -1 : Math.min(Math.max(highlighted, 0), optionCount - 1);
  const listOpen = open && optionCount > 0;

  function selectResult(r: SpeciesResult) {
    setOpen(false);
    setQuery("");
    const select = onSelectRef.current;
    if (select) select(r);
    else navigate(`/species/${r.id}${regionId ? `?regionId=${encodeURIComponent(regionId)}` : ""}`);
  }

  function openInatSearch() {
    setOpen(false);
    setOtherTaxaModalOpen(true);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      if (optionCount > 0) setHighlighted((active + 1) % optionCount);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (optionCount > 0) setHighlighted((active - 1 + optionCount) % optionCount);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (resultsFor !== query.trim()) {
        // Results are still for an older query: fetch now and pick the top match on arrival.
        enterPendingRef.current = true;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        fetchResults(query.trim());
        return;
      }
      if (showInatRow && active === results.length) openInatSearch();
      else if (results[active]) selectResult(results[active]);
    } else if (e.key === "Escape" && listOpen) {
      // Close just the suggestions, not an enclosing dialog too.
      e.preventDefault();
      setOpen(false);
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div className="relative w-64">
      <SearchInput
        value={query}
        onChange={(v) => {
          setQuery(v);
          setOpen(true);
        }}
        placeholder={placeholder ?? "Jump to species…"}
        autoFocus={autoFocus}
        aria-label={placeholder ?? "Jump to species"}
        onFocus={() => {
          if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
          setOpen(true);
        }}
        onBlur={() => {
          blurTimerRef.current = setTimeout(() => setOpen(false), 100);
        }}
        onKeyDown={handleKeyDown}
        inputProps={{
          role: "combobox",
          autoComplete: "off",
          spellCheck: false,
          "aria-autocomplete": "list",
          "aria-expanded": listOpen,
          "aria-controls": listId,
          "aria-activedescendant": listOpen && active >= 0 ? optionId(active) : undefined,
        }}
      />
      {listOpen && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Species"
          className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-line bg-surface shadow-lg"
        >
          {results.map((r, i) => (
            <li
              key={r.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                selectResult(r);
              }}
              onMouseEnter={() => setHighlighted(i)}
              className={`cursor-pointer px-3 py-2 text-sm ${i === active ? "bg-surface-muted" : ""}`}
            >
              <span className="font-medium text-ink">{r.common_name ?? r.scientific_name}</span>{" "}
              <span className="italic text-muted">{r.scientific_name}</span>
            </li>
          ))}
          {showInatRow && (
            <li
              id={optionId(results.length)}
              role="option"
              aria-selected={active === results.length}
              onMouseDown={(e) => {
                e.preventDefault();
                openInatSearch();
              }}
              onMouseEnter={() => setHighlighted(results.length)}
              className={`cursor-pointer px-3 py-2 text-left text-sm text-accent ${active === results.length ? "bg-surface-muted" : ""}`}
            >
              {results.length === 0 ? `No local match for "${query}", search` : "Search"} iNaturalist ↗
            </li>
          )}
        </ul>
      )}
      {otherTaxaModalOpen && (
        <AddOtherTaxaModal
          initialQuery={query}
          onClose={() => {
            setOtherTaxaModalOpen(false);
            setQuery("");
          }}
        />
      )}
    </div>
  );
}
