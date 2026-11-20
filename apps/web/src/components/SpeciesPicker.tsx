import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { matches } from "../lib/keymap";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { SEARCH_DEBOUNCE_MS } from "../lib/searchNormalize";
import AddOtherTaxaModal from "./AddOtherTaxaModal";
import type { SpeciesResult } from "./speciesResult";
import type { ProbableGroup } from "./ProbableGroupText";
import SearchInput from "./SearchInput";
import { useLatest } from "../hooks/useLatest";
import { useSettings } from "../hooks/useSettings";
import { namePartClass, useSpeciesNameParts } from "../lib/speciesName";
import SpeciesNameText from "./SpeciesNameText";
import { useAnchoredBox } from "../lib/anchoredBox";

export type { SpeciesResult };

export interface SuggestedSpecies extends SpeciesResult {
  /** Blended image+text match score, 0-1. */
  score: number;
  /** Only on the top suggestion when it clears the margin-over-runner-up rule (embeddings.ts
   *  markConfidence). Use this, not a raw score, to decide on a "no confident match" caption. */
  confident?: boolean;
  /** 0-100: show this, not `Math.round(score * 100)` (see embeddings.ts assignDisplayPercents). */
  matchPercent?: number;
  /** Only on a top suggestion that isn't confident: the genus (else family) the close guesses share. */
  probably?: ProbableGroup;
  /** What it matched on; "keyword_tag" is a species named in the photo's own keywords. */
  source?: string;
}

// Fuzzy species search, recent species when empty. With onSelect it assigns inline (bulk import,
// ID correction); without it, it jumps to the species page. Either way it offers the iNaturalist
// fallback, which with onSelect assigns the added species too.
export default function SpeciesPicker({
  onSelect,
  autoFocus,
  placeholder,
  regionId,
  inline = false,
  anchorRef,
  ariaLabel,
}: {
  onSelect?: (r: SpeciesResult) => void;
  autoFocus?: boolean;
  placeholder?: string;
  /** Ranks this region's checklist first. */
  regionId?: string | null;
  /** Full width with the results listed below it rather than dropped over the page, for a dialog. */
  inline?: boolean;
  /** Shows the results as a popover against this element (a card the field sits in), on the
   *  page's top layer, below or above as there's room. The field then fills its container. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** When the placeholder is only an example. */
  ariaLabel?: string;
}) {
  const { t } = useTranslation();
  const speciesNameParts = useSpeciesNameParts();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SpeciesResult[]>([]);
  // The query `results` answer, so Enter never picks from an older query's list.
  const [resultsFor, setResultsFor] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const anyTaxaSearchEnabled = useSettings().settings?.anyTaxaSearchEnabled ?? false;
  const [otherTaxaModalOpen, setOtherTaxaModalOpen] = useState(false);
  const navigate = useNavigate();
  const listId = useId();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Enter pressed before the current query's results arrived: pick the top one when they do.
  const enterPendingRef = useRef(false);
  const onSelectRef = useLatest(onSelect);

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
  const fetchRef = useLatest(fetchResults);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    debounceRef.current = setTimeout(() => fetchRef.current(q), SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, regionId, fetchRef]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    },
    [],
  );

  const showInatRow = anyTaxaSearchEnabled && query.trim().length >= 2;
  const optionCount = results.length + (showInatRow ? 1 : 0);
  // Clamped so a shorter result list never leaves the highlight past the end.
  const active = optionCount === 0 ? -1 : Math.min(Math.max(highlighted, 0), optionCount - 1);
  const listOpen = (inline || open) && optionCount > 0;
  // With iNaturalist search on, its row already covers an empty result.
  const noMatch =
    (inline || open) &&
    !anyTaxaSearchEnabled &&
    query.trim().length >= 2 &&
    resultsFor === query.trim() &&
    !results.length;

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
    if (matches(e, "listNext")) {
      e.preventDefault();
      setOpen(true);
      if (optionCount > 0) setHighlighted((active + 1) % optionCount);
    } else if (matches(e, "listPrevious")) {
      e.preventDefault();
      if (optionCount > 0) setHighlighted((active - 1 + optionCount) % optionCount);
    } else if (matches(e, "choose")) {
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
    } else if (matches(e, "close") && listOpen && !inline) {
      // Close just the suggestions, not an enclosing dialog too. Inline, the list is the dialog's
      // content, so Escape closes the dialog.
      e.preventDefault();
      setOpen(false);
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`;

  // Anchored, the list or the no-match note floats on the page's top layer against the anchor.
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverBox = useAnchoredBox(!!anchorRef && (listOpen || noMatch), anchorRef, popoverRef);
  const popover = (content: ReactNode) =>
    !anchorRef || !content
      ? content
      : createPortal(
          <div
            ref={popoverRef}
            data-species-popover
            style={popoverBox ?? { visibility: "hidden" }}
            // Keeps focus in the field, so its blur doesn't close the list before a pick.
            onMouseDown={(e) => e.preventDefault()}
            className="fixed z-50 flex flex-col overflow-hidden rounded-panel shadow-lg"
          >
            {content}
          </div>,
          document.body,
        );

  return (
    <div className={inline || anchorRef ? "w-full" : "relative w-64"}>
      <SearchInput
        value={query}
        onChange={(v) => {
          setQuery(v);
          setOpen(true);
        }}
        placeholder={placeholder ?? t("species.picker.placeholder")}
        autoFocus={autoFocus}
        aria-label={ariaLabel ?? placeholder ?? t("species.picker.label")}
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
      {popover(
        listOpen && (
          <ul
            id={listId}
            role="listbox"
            aria-label={t("species.picker.listLabel")}
            className={`w-full overflow-y-auto rounded-panel border border-line bg-surface ${
              inline ? "mt-2 max-h-80" : anchorRef ? "min-h-0" : "absolute z-10 mt-1 max-h-72 shadow-lg"
            }`}
          >
            {results.map((r, i) => {
              const { primary, secondary } = speciesNameParts(r);
              return (
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
                  className={`cursor-pointer px-3 py-2 text-callout wrap-anywhere ${i === active ? "bg-surface-muted" : ""}`}
                >
                  <span className={`font-medium text-ink ${namePartClass(primary)}`}>{primary.text}</span>
                  {secondary.length > 0 && (
                    <>
                      {" "}
                      <span className="text-muted">
                        <SpeciesNameText parts={secondary} />
                      </span>
                    </>
                  )}
                </li>
              );
            })}
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
                className={`cursor-pointer px-3 py-2 text-left text-callout text-accent ${active === results.length ? "bg-surface-muted" : ""}`}
              >
                {results.length === 0
                  ? t("species.picker.searchInaturalistNoMatch", { query })
                  : t("species.picker.searchInaturalist")}
              </li>
            )}
          </ul>
        ),
      )}
      {popover(
        noMatch && (
          <div
            className={`w-full rounded-panel border border-line bg-surface px-3 py-2 text-callout text-muted ${
              inline ? "mt-2" : anchorRef ? "" : "absolute z-10 mt-1 shadow-lg"
            }`}
          >
            <p>{t("species.picker.noMatch")}</p>
            <Link
              to="/settings/species"
              // Keeps focus so the blur timer doesn't close this before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              className="mt-1 block text-footnote underline hover:text-ink"
            >
              {t("species.picker.turnOnInaturalist")}
            </Link>
          </div>
        ),
      )}
      {otherTaxaModalOpen && (
        <AddOtherTaxaModal
          initialQuery={query}
          initialRegionId={regionId}
          onAdded={onSelect ? selectResult : undefined}
          onClose={() => {
            setOtherTaxaModalOpen(false);
            setQuery("");
          }}
        />
      )}
    </div>
  );
}
