import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import SearchInput from "./SearchInput";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { MENU_PANEL } from "../lib/menuClasses";
import Button from "./Button";
import { highlightedArea } from "../lib/mapAreaOutlines";

const MAX_ROWS = 2;
const LIST_WIDTH_PX = 256;

type Area = { id: string; name: string };

/** A region's areas as pills, up to two rows; past that the second row ends in "+ N more", a
 *  searchable list of the rest, so a country with 50 states doesn't push the species down. When
 *  some don't fit, areas with your photos come first, so the places you go back to stay visible.
 *  Every list of areas to pick from (Collection header, region pickers) uses this one. */
export default function AreaPills({
  label,
  areas: given,
  withPhotos,
  onPick,
  trailing,
}: {
  /** Leads the first row; none when something beside the pills already says what they are. */
  label?: string;
  areas: Area[];
  /** Ids of regions you have photos in. */
  withPhotos?: Set<string> | null;
  onPick: (id: string) => void;
  /** Shown after the pills (the drill-down button). */
  trailing?: React.ReactNode;
}) {
  const mine = (a: Area) => !!withPhotos?.has(a.id);
  // Alphabetical while everything fits; once some go behind "+ N more", your areas lead so
  // they stay visible.
  const areas = [...given].sort((a, b) => a.name.localeCompare(b.name));
  const mineFirst = [...areas].sort((a, b) => Number(mine(b)) - Number(mine(a)));
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);
  // How many pills fit, or null to lay them all out and measure.
  const [shown, setShown] = useState<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const { openKey, setOpenKey, ref: menuRef } = useDropdownMenu<true>();
  const [query, setQuery] = useState("");
  // The list opens leftwards when the pill sits too close to the window's right edge.
  const [openLeft, setOpenLeft] = useState(false);
  // Pointing at or focusing an area lights its outline on the map, and the reverse.
  const highlighted = highlightedArea.use();
  const lights = (id: string) => ({
    onPointerEnter: () => highlightedArea.set(id),
    onPointerLeave: () => highlightedArea.set(null),
    onFocus: () => highlightedArea.set(id),
    onBlur: () => highlightedArea.set(null),
  });
  // The pill goes away with the page, so no pointer-leave clears it.
  const pick = (id: string) => {
    highlightedArea.set(null);
    onPick(id);
  };

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(() => setSize({ width: row.clientWidth, height: row.clientHeight }));
    observer.observe(row);
    // A web font arriving widens the pills without resizing the row's width.
    let live = true;
    if (document.fonts && document.fonts.status !== "loaded")
      void document.fonts.ready.then(() => live && setSize({ width: 0, height: 0 }));
    return () => {
      live = false;
      observer.disconnect();
    };
  }, []);

  // A new width or list measures again from scratch.
  const [measuredFor, setMeasuredFor] = useState<string>("");
  const key = `${size.width}|${areas.map((a) => a.id).join(",")}`;
  if (measuredFor !== key) {
    setMeasuredFor(key);
    setShown(null);
  }

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const pills = [...row.querySelectorAll<HTMLElement>("[data-area-pill]")];
    const tops = [...new Set(pills.map((p) => p.offsetTop))].sort((a, b) => a - b);
    const more = row.querySelector<HTMLElement>("[data-area-more]");
    // The label sits on the first row, so rows are counted from the pills' own tops. Pills on a
    // third row (from the first layout, or text that grew afterwards) are cut back to two rows,
    // one slot going to "+ N more"; the check after takes more back if that still wraps.
    if (tops.length > MAX_ROWS) {
      const lastRowTop = tops[MAX_ROWS - 1];
      const fit = pills.filter((p) => p.offsetTop <= lastRowTop).length;
      setShown(Math.max(1, fit - 1));
      return;
    }
    if (shown !== null && more && shown > 1 && more.offsetTop > tops[tops.length - 1]) setShown(shown - 1);
  }, [shown, key, size.height]);

  const visible = shown === null ? areas : mineFirst.slice(0, shown);
  const rest = shown === null ? [] : mineFirst.slice(shown).sort((a, b) => a.name.localeCompare(b.name));
  const matches = query.trim() ? rest.filter((a) => a.name.toLowerCase().includes(query.trim().toLowerCase())) : rest;

  return (
    <div ref={rowRef} className="flex flex-wrap items-center gap-2">
      {label && <span className="text-footnote text-muted">{label}</span>}
      {visible.map((area) => (
        <span key={area.id} title={area.name} data-area-pill="" className="flex max-w-64" {...lights(area.id)}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => pick(area.id)}
            className={`min-w-0 truncate ${highlighted === area.id ? "border-link! bg-surface-muted!" : ""}`}
          >
            {area.name}
          </Button>
        </span>
      ))}
      {rest.length > 0 && (
        <div ref={menuRef} className="relative" data-area-more="">
          <Button
            variant="secondary"
            size="sm"
            onClick={(e) => {
              const pill = e.currentTarget.getBoundingClientRect();
              setOpenLeft(pill.left + LIST_WIDTH_PX + 16 > window.innerWidth);
              setOpenKey(openKey ? null : true);
            }}
            aria-expanded={!!openKey}
            className="text-muted"
          >
            {t("collection.breadcrumb.moreAreas", { count: rest.length })}
          </Button>
          {/* A searchable list rather than an action Menu: typing filters it, so arrow keys and
              typeahead belong to the search box. */}
          {openKey && (
            <div
              className={`absolute top-full z-30 mt-1 p-2 ${openLeft ? "right-0" : "left-0"} ${MENU_PANEL}`}
              style={{ width: LIST_WIDTH_PX }}
            >
              <SearchInput
                value={query}
                onChange={setQuery}
                autoFocus
                placeholder={t("collection.breadcrumb.searchAreas")}
                aria-label={t("collection.breadcrumb.searchAreas")}
              />
              <div className="mt-1 max-h-72 overflow-y-auto">
                {matches.map((area) => (
                  <Button
                    key={area.id}
                    {...lights(area.id)}
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setOpenKey(null);
                      setQuery("");
                      pick(area.id);
                    }}
                    // Long names wrap inside the row instead of spilling over the next one.
                    className="h-auto! min-h-8 w-full justify-start py-1 text-left whitespace-normal break-words"
                  >
                    {area.name}
                  </Button>
                ))}
                {matches.length === 0 && (
                  <p className="px-3 py-2 text-footnote text-muted">{t("collection.breadcrumb.noAreaMatch")}</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {trailing}
    </div>
  );
}
