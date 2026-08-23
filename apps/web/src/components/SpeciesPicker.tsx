import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";

export interface SpeciesResult {
  id: string;
  scientific_name: string;
  common_name: string | null;
}

// Fuzzy search across common + scientific name, recently-used pinned when the query is empty
// (lifer-spec.md §9 Phase 2 checklist). Keyboard-driven: arrow keys + enter to jump.
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
  const navigate = useNavigate();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      <input
        type="text"
        value={query}
        placeholder={placeholder ?? "Jump to species…"}
        autoFocus={autoFocus}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 100)}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full rounded-md border border-line px-3 py-1.5 text-sm"
      />
      {open && results.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full rounded-md border border-line bg-surface shadow-lg">
          {results.map((r, i) => (
            <li
              key={r.id}
              onMouseDown={() => selectResult(r)}
              className={`cursor-pointer px-3 py-2 text-sm ${i === highlighted ? "bg-surface-muted" : ""}`}
            >
              <span className="font-medium text-ink">{r.common_name ?? r.scientific_name}</span>{" "}
              <span className="italic text-muted">{r.scientific_name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
