import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import AddOtherTaxaModal from "./AddOtherTaxaModal";
import SearchInput from "./SearchInput";

export interface SpeciesResult {
  id: string;
  scientific_name: string;
  common_name: string | null;
}

export interface SuggestedSpecies extends SpeciesResult {
  /** Blended image+text match score, 0-1 — shown to the user as a rounded percent match. */
  score: number;
  /** Set only on the single top-ranked suggestion when it clears the margin-over-runner-up
   *  confidence rule (embeddings.ts's markConfidence) — absent on a keyword_tag suggestion,
   *  which is a certain exact match by construction. Use this, not a raw score comparison, to
   *  decide whether to show a "no confident match" caption. */
  confident?: boolean;
  /** 0-100 — show THIS, not `Math.round(score * 100)`, as the user-facing match percentage.
   *  See embeddings.ts's assignDisplayPercents for why the raw score no longer reads as an
   *  intuitive percent once the zero-shot text signal is blended in. */
  matchPercent?: number;
}

// Fuzzy search across common + scientific name, recently-used pinned when the query is empty
// (Phase 2 checklist). Keyboard-driven: arrow keys + enter to jump.
//
// Defaults to navigating to the species page (header "jump to species" usage) — the bulk
// import picker (Phase 5) passes onSelect/autoFocus instead, to assign a row inline and move
// on rather than leaving the page, without a second near-identical component to maintain.
export default function SpeciesPicker({
  onSelect,
  autoFocus,
  placeholder,
}: {
  onSelect?: (r: SpeciesResult) => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SpeciesResult[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [anyTaxaSearchEnabled, setAnyTaxaSearchEnabled] = useState(false);
  const [otherTaxaModalOpen, setOtherTaxaModalOpen] = useState(false);
  const navigate = useNavigate();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Only the default "jump to species" usage (header nav) offers the iNaturalist fallback — the
  // bulk-import picker passes onSelect and has its own region already chosen for the whole
  // batch, which doesn't fit "search iNaturalist, then pick a region" as a per-row action.
  useEffect(() => {
    if (onSelect) return;
    api
      .get<{ anyTaxaSearchEnabled: boolean }>("/settings")
      .then((res) => setAnyTaxaSearchEnabled(res.anyTaxaSearchEnabled))
      .catch(() => {});
  }, [onSelect]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      api.get<{ results: SpeciesResult[] }>(`/species?q=${encodeURIComponent(query)}`).then((res) => {
        setResults(res.results);
        setHighlighted(0);
      });
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  function selectResult(r: SpeciesResult) {
    setOpen(false);
    setQuery("");
    if (onSelect) onSelect(r);
    else navigate(`/species/${r.id}`);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[highlighted]) selectResult(results[highlighted]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="relative w-64">
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder={placeholder ?? "Jump to species…"}
        autoFocus={autoFocus}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 100)}
        onKeyDown={handleKeyDown}
      />
      {open && (results.length > 0 || (anyTaxaSearchEnabled && query.trim().length >= 2)) && (
        <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-line bg-surface shadow-lg">
          {results.map((r, i) => (
            <li
              key={r.id}
              onMouseDown={() => selectResult(r)}
              onMouseEnter={() => setHighlighted(i)}
              className={`cursor-pointer px-3 py-2 text-sm ${i === highlighted ? "bg-surface-muted" : ""}`}
            >
              <span className="font-medium text-ink">{r.common_name ?? r.scientific_name}</span>{" "}
              <span className="italic text-muted">{r.scientific_name}</span>
            </li>
          ))}
          {anyTaxaSearchEnabled && query.trim().length >= 2 && (
            <li>
              <button
                type="button"
                onMouseDown={() => {
                  setOpen(false);
                  setOtherTaxaModalOpen(true);
                }}
                onMouseEnter={() => setHighlighted(-1)}
                className="w-full px-3 py-2 text-left text-sm text-accent hover:bg-surface-muted"
              >
                {results.length === 0 ? `No local match for "${query}", search` : "Search"} iNaturalist ↗
              </button>
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
