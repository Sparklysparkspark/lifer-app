import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { matches } from "../lib/keymap";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../api/client";
import { useAnchoredPosition } from "../hooks/useAnchoredPosition";
import { useRegions } from "../hooks/useRegions";
import { SEARCH_DEBOUNCE_MS } from "../lib/searchNormalize";
import TextField from "./TextField";

export type PlaceSuggestion = ApiResponse<"/places">["places"][number];

/** "Region, Country" for a suggestion, or null when it has no region. */
export function usePlaceRegionText(): (p: PlaceSuggestion) => string | null {
  const { t } = useTranslation();
  return (p) =>
    p.regionName && p.countryName
      ? t("placeName.regionInCountry", { region: p.regionName, country: p.countryName })
      : p.regionName;
}

// Free-text place name with suggestions from the names already used, so the same place gets the
// same spelling. Names used in `regionId` come first. Typing a new name works as before.
export default function PlaceNameInput({
  id,
  value,
  onChange,
  regionId,
  onlyInRegion,
  onPick,
  autoFocus,
  className,
  size,
  "aria-label": ariaLabel,
}: {
  /** For the caller's <label htmlFor>: a wrapping label would read the suggestions into its name. */
  id: string;
  value: string;
  onChange: (value: string) => void;
  regionId?: string | null;
  /** Suggest only names used in `regionId` (or inside it). */
  onlyInRegion?: boolean;
  /** A suggestion was picked, as opposed to typed. */
  onPick?: (name: string) => void;
  autoFocus?: boolean;
  className?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
}) {
  const { t } = useTranslation();
  const regionText = usePlaceRegionText();
  const [results, setResults] = useState<PlaceSuggestion[]>([]);
  const [resultsFor, setResultsFor] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // -1: nothing highlighted, so Enter keeps a newly typed name instead of picking a suggestion.
  const [highlighted, setHighlighted] = useState(-1);
  const listId = useId();
  const abortRef = useRef<AbortController | null>(null);

  const query = value.trim();
  useEffect(() => {
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      api
        .get(apiPath("/places", {}, { q: query, regionId: regionId ?? undefined, limit: 20 }), {
          signal: controller.signal,
        })
        .then((res) => {
          if (controller.signal.aborted) return;
          setResults(res.places);
          setResultsFor(query);
          setHighlighted(-1);
        })
        .catch(() => {});
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, regionId]);
  useEffect(() => () => abortRef.current?.abort(), []);

  // The exact name already typed isn't worth suggesting.
  const options = results.filter((p) => p.name !== value && (!onlyInRegion || !regionId || p.inRegion));
  const listOpen = open && options.length > 0;
  const fieldRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // On the top layer, so a dialog body's scroll never clips the list. 240px is the list's cap.
  const listStyle = useAnchoredPosition(fieldRef, listRef, listOpen, { matchWidth: true, maxHeight: 240 });
  const active = highlighted < options.length ? highlighted : -1;

  // A name already used in the region, else the catalog's example city for it.
  const { regions } = useRegions();
  const catalogExample = regionId ? (regions?.find((r) => r.id === regionId)?.exampleCity ?? null) : null;
  const example = (resultsFor === "" && results[0]?.inRegion ? results[0].name : null) ?? catalogExample;
  const placeholder = example
    ? t("captureEdit.location.placeNameExample", { name: example })
    : t("captureEdit.location.placeNamePlaceholder");

  function pick(p: PlaceSuggestion) {
    onChange(p.name);
    onPick?.(p.name);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (matches(e, "listNext")) {
      e.preventDefault();
      setOpen(true);
      if (options.length > 0) setHighlighted((active + 1) % options.length);
    } else if (matches(e, "listPrevious")) {
      e.preventDefault();
      if (options.length > 0) setHighlighted(active <= 0 ? options.length - 1 : active - 1);
    } else if (matches(e, "choose") && listOpen && active >= 0) {
      e.preventDefault();
      pick(options[active]);
    } else if (matches(e, "close") && listOpen) {
      // Close just the suggestions, not an enclosing dialog too.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div ref={fieldRef} className="relative">
      <TextField
        id={id}
        type="text"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlighted(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={listOpen}
        aria-controls={listId}
        aria-activedescendant={listOpen && active >= 0 ? optionId(active) : undefined}
        aria-label={ariaLabel}
        size={size}
        className={className}
      />
      {listOpen &&
        createPortal(
          <ul
            ref={listRef}
            style={listStyle}
            id={listId}
            role="listbox"
            aria-label={t("placeName.listLabel")}
            className="z-50 min-w-56 overflow-y-auto rounded-panel border border-line bg-surface shadow-lg"
          >
            {options.map((p, i) => {
              const region = regionText(p);
              return (
                <li
                  key={p.name}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  // Keeps focus in the input, so its blur doesn't close the list before the pick.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(p);
                  }}
                  onMouseEnter={() => setHighlighted(i)}
                  className={`cursor-pointer px-3 py-1.5 text-callout ${i === active ? "bg-surface-muted" : ""}`}
                >
                  <span className="text-ink">{p.name}</span>{" "}
                  <span className="text-footnote text-muted">
                    {region
                      ? t("placeName.detail", { region, count: p.count })
                      : t("placeName.detailNoRegion", { count: p.count })}
                  </span>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </div>
  );
}
