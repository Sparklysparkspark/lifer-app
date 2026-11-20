import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type UIEvent,
} from "react";
import { createPortal } from "react-dom";
import { matches } from "../lib/keymap";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../api/client";
import { useLatest } from "../hooks/useLatest";
import { useOnlinePlaces } from "../hooks/useOnlinePlaces";
import { formatNumber } from "../lib/format";
import { ignore } from "../lib/ignore";
import {
  dedupePlaces,
  ONLINE_SEARCH_DEBOUNCE_MS,
  ONLINE_SEARCH_MIN_LENGTH,
  PHOTON_ATTRIBUTION,
  searchPlaces,
  type OnlinePlace,
  type OnlinePlaceKind,
} from "../lib/onlinePlaces";
import { SEARCH_DEBOUNCE_MS } from "../lib/searchNormalize";
import Button from "./Button";
import PlusIcon from "./PlusIcon";
import SearchInput from "./SearchInput";
import { placeLine } from "../lib/placeLine";

/** One of the user's places or a region, from the library. */
export type PickedPlace = ApiResponse<"/places/locate">["places"][number];
/** A library place, or a place found online (kind "online"). */
export type FoundPlace = PickedPlace | OnlinePlace;
type Point = { lat: number; lon: number };

const GROUP_KEY = {
  nearby: "placePicker.group.nearby",
  recent: "placePicker.group.recent",
  all: "placePicker.group.all",
} as const;
const KIND_KEYS: Record<OnlinePlaceKind, string | null> = {
  town: "placeSearch.kind.town",
  park: "placeSearch.kind.park",
  water: "placeSearch.kind.water",
  address: "placeSearch.kind.address",
  region: "placeSearch.kind.region",
  other: null,
};
const PRIVACY_KEY = { obscured: "savedSpots.privacy.obscured", private: "savedSpots.privacy.private" } as const;
const NEW_PLACE = "new-place";
/** "Add “King Fisher Pond” as a new place", first while typing a name that isn't a place yet. */
const ADD_TYPED = "add-typed";
const ONLINE_GROUP = "online";
const ROW = "cursor-pointer px-3 py-1.5 text-callout";
const ROW_ACTIVE = `${ROW} bg-surface-muted`;
const LIST_MAX_PX = 320;
const LIST_MIN_PX = 224;
const EDGE_PX = 8;
const GAP_PX = 4;

/** Where the list sits: under the field, or above it when there's more room there, kept inside the window. */
function listBox(field: DOMRect, rows: number): CSSProperties {
  const below = window.innerHeight - field.bottom - GAP_PX - EDGE_PX;
  const above = field.top - GAP_PX - EDGE_PX;
  const width = Math.min(Math.max(field.width, LIST_MIN_PX), window.innerWidth - 2 * EDGE_PX);
  const left = Math.min(Math.max(EDGE_PX, field.left), window.innerWidth - width - EDGE_PX);
  const up = below < (rows || LIST_MAX_PX) && above > below;
  return up
    ? { left, width, bottom: window.innerHeight - field.top + GAP_PX, maxHeight: Math.min(LIST_MAX_PX, above) }
    : { left, width, top: field.bottom + GAP_PX, maxHeight: Math.min(LIST_MAX_PX, below) };
}

/** "350 m" or "4.2 km". */
function useDistance() {
  const { t } = useTranslation();
  return (m: number) =>
    m < 1000
      ? t("placePicker.metres", { distance: formatNumber(Math.round(m / 10) * 10) })
      : t("placePicker.km", { distance: formatNumber(m / 1000, { maximumFractionDigits: m < 10_000 ? 1 : 0 }) });
}

const groupOf = (p: FoundPlace) => (p.kind === "online" ? ONLINE_GROUP : p.group);

// The house place picker and search. With nothing typed it lists the user's places: Nearby (a
// place the photos are already inside comes first), Recent and All in pages. Typed, it searches
// the user's places and regions locally, then, when online and allowed, places found online under
// their own heading. Only the typed text and the rounded `bias` leave the computer; `near` never does.
export default function PlacePicker({
  onPick,
  placeholder,
  near,
  bias,
  regionLabel,
  onNewPlace,
  onOpenChange,
  towns,
  value,
  onValueChange,
  overlay,
  autoFocus,
  "aria-label": ariaLabel,
}: {
  onPick: (place: FoundPlace) => void;
  placeholder: string;
  /** The photos' point, to rank Nearby and recognise a place they're in. Local only. */
  near?: Point | null;
  /** The map's centre, to rank online results nearby. Never a photo's location. */
  bias?: () => Point | null;
  /** How a region result reads, e.g. "(centre of the area)" when its centre is used as a point. */
  regionLabel?: (place: PickedPlace) => string;
  /** Adds "New place from the map" as the last row. */
  onNewPlace?: (name?: string) => void;
  /** The list showed or hid, e.g. to hide a line it repeats. */
  onOpenChange?: (open: boolean) => void;
  /** Towns and areas only (no saved spots, nothing listed until typed), each as one line. */
  towns?: boolean;
  /** With these the text is the caller's, free text included, and stays after a pick. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Lays the list over what's below (a map) instead of making room for it. */
  overlay?: boolean;
  autoFocus?: boolean;
  "aria-label"?: string;
}) {
  const { t } = useTranslation();
  const distance = useDistance();
  const listId = useId();
  const onlinePlaces = useOnlinePlaces();
  const biasRef = useLatest(bias);
  const [ownTerm, setOwnTerm] = useState("");
  const term = value ?? ownTerm;
  const setTerm = (v: string) => (onValueChange ? onValueChange(v) : setOwnTerm(v));
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<{ q: string; places: PickedPlace[] } | null>(null);
  const [online, setOnline] = useState<{ q: string; places: OnlinePlace[]; failed: boolean } | null>(null);
  const [browse, setBrowse] = useState<{ key: string; places: PickedPlace[]; next: number | null } | null>(null);
  const [highlighted, setHighlighted] = useState(-1);
  const fieldRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<CSSProperties | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Room kept under the field for the open list, so it never covers the controls below it.
  const [reserve, setReserve] = useState(0);
  const onOpenChangeRef = useLatest(onOpenChange);
  const loadingMore = useRef(false);
  // The search route takes up to 200 characters.
  const q = term.trim().slice(0, 200);
  const nearParam = near ? `${near.lat},${near.lon}` : undefined;
  const browseKey = nearParam ?? "";
  const wantsOnline = onlinePlaces.enabled && q.length >= ONLINE_SEARCH_MIN_LENGTH;

  // Typed: the library search, debounced.
  useEffect(() => {
    if (!q) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .get(apiPath("/places/locate", {}, { q, near: nearParam }), { signal: controller.signal })
        .then((res) => setFound({ q, places: res.places }))
        .catch(ignore("Couldn't search places"));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, nearParam]);

  // Slower than the library search, so a word is finished before anything leaves the device.
  useEffect(() => {
    if (!wantsOnline) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchPlaces(q, { bias: biasRef.current?.() ?? null, signal: controller.signal })
        .then((places) => setOnline({ q, places, failed: false }))
        .catch((err: Error) => {
          if (err.name !== "AbortError") setOnline({ q, places: [], failed: true });
        });
    }, ONLINE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, wantsOnline, biasRef]);

  // Nothing typed: the groups, fetched each time the list opens so a new place shows.
  useEffect(() => {
    if (!open || q || towns) return;
    const controller = new AbortController();
    api
      .get(apiPath("/places/locate", {}, { near: nearParam }), { signal: controller.signal })
      .then((res) => setBrowse({ key: browseKey, places: res.places, next: res.nextOffset }))
      .catch(ignore("Couldn't list places"));
    return () => controller.abort();
  }, [open, q, nearParam, browseKey, towns]);

  const searched = q
    ? found?.q === q
      ? found.places
      : []
    : towns
      ? []
      : browse?.key === browseKey
        ? browse.places
        : [];
  const local = towns ? searched.filter((p) => p.kind !== "spot") : searched;
  const current = wantsOnline && online?.q === q ? online : null;
  // A place of the user's with the same name nearby wins over the online copy.
  const fromOnline = current ? dedupePlaces(current.places, local) : [];
  const listed: FoundPlace[] = [...local, ...fromOnline];
  const typedName = term.trim().slice(0, 500);
  const same = (a: string) => a.localeCompare(typedName, undefined, { sensitivity: "base" }) === 0;
  // Typing a name that isn't one of the user's places makes adding it the first choice.
  const offerTyped = !!onNewPlace && !!q && !local.some((p) => p.kind === "spot" && same(p.name));
  const options: Array<FoundPlace | typeof NEW_PLACE | typeof ADD_TYPED> = !onNewPlace
    ? listed
    : q
      ? offerTyped
        ? [ADD_TYPED, ...listed]
        : listed
      : [...listed, NEW_PLACE];
  const noticeDue = wantsOnline && onlinePlaces.noticeDue;
  // Asked online and not answered yet: a slow connection is "searching", never "offline".
  const searching = wantsOnline && !current;
  const hasFooter = !!q && (searching || !!current?.failed || fromOnline.length > 0);
  const listOpen = open && (options.length > 0 || hasFooter || noticeDue);
  const active = highlighted < options.length ? highlighted : -1;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  useEffect(() => onOpenChangeRef.current?.(listOpen), [listOpen, onOpenChangeRef]);

  // On the page's top layer, so a dialog's edge never clips it. Checked each frame while open, so
  // it follows the field however it moves (scrolling, a dialog re-centring around the kept room).
  useLayoutEffect(() => {
    if (!listOpen) return;
    let last = "";
    let frame = 0;
    const place = () => {
      const field = fieldRef.current?.getBoundingClientRect();
      // As tall as its rows, up to the cap: one short row is a short box.
      const rows = Math.min(boxRef.current?.scrollHeight ?? 0, LIST_MAX_PX);
      if (field) {
        const key = `${field.top},${field.left},${field.width},${rows},${window.innerWidth},${window.innerHeight}`;
        if (key !== last) {
          last = key;
          setBox(listBox(field, rows));
          if (!overlay) setReserve(rows + GAP_PX);
        }
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [listOpen, overlay]);

  function loadMore() {
    if (q || !browse?.next || loadingMore.current) return;
    loadingMore.current = true;
    const at = browse;
    api
      .get(apiPath("/places/locate", {}, { near: nearParam, offset: at.next! }))
      .then((res) =>
        setBrowse((b) => (b === at ? { ...b, places: [...b.places, ...res.places], next: res.nextOffset } : b)),
      )
      .catch(ignore("Couldn't list more places"))
      .finally(() => (loadingMore.current = false));
  }

  function choose(option: FoundPlace | typeof NEW_PLACE | typeof ADD_TYPED) {
    setOpen(false);
    setHighlighted(-1);
    if (option === NEW_PLACE) return onNewPlace?.();
    if (option === ADD_TYPED) {
      if (value === undefined) setTerm("");
      return onNewPlace?.(typedName);
    }
    if (value === undefined) setTerm("");
    onPick(option);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (matches(e, "listNext")) {
      e.preventDefault();
      setOpen(true);
      if (options.length > 0) {
        const next = (active + 1) % options.length;
        setHighlighted(next);
        if (next >= options.length - 3) loadMore();
      }
    } else if (matches(e, "listPrevious")) {
      e.preventDefault();
      if (options.length > 0) setHighlighted(active <= 0 ? options.length - 1 : active - 1);
    } else if (matches(e, "choose") && listOpen && active >= 0) {
      e.preventDefault();
      choose(options[active]);
    } else if (matches(e, "close") && listOpen) {
      // Closes just the list; focus stays in the field, and an enclosing dialog stays open.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  // Keeps the highlighted row in view as the arrows move.
  useEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  });

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) loadMore();
  }

  function rowText(option: FoundPlace): { name: string; second: string | null; privacy: string | null } {
    if (towns) return { name: placeLine(option), second: null, privacy: null };
    if (option.kind === "online") {
      const key = KIND_KEYS[option.placeKind];
      const second = [key && t(key), option.region].filter(Boolean).join(", ");
      return { name: option.name, second: second || null, privacy: null };
    }
    const name =
      option.kind === "region" && regionLabel
        ? regionLabel(option)
        : option.recognised && option.group === "nearby"
          ? t("placePicker.looksLike", { name: option.name })
          : option.name;
    const privacy = option.geoprivacy && option.geoprivacy !== "open" ? t(PRIVACY_KEY[option.geoprivacy]) : null;
    return { name, second: option.locality ?? option.detail, privacy };
  }

  return (
    <div className="relative">
      {/* Just the field: the list is placed against it, never against the room kept below. */}
      <div ref={fieldRef}>
        <SearchInput
          size="md"
          value={term}
          onChange={(v) => {
            setTerm(v);
            setOpen(true);
            setHighlighted(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel ?? placeholder}
          autoFocus={autoFocus}
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
      </div>
      {listOpen && reserve > 0 && <div aria-hidden data-place-room style={{ height: reserve }} />}
      {listOpen &&
        createPortal(
          <div
            data-place-list
            ref={boxRef}
            style={box ?? { visibility: "hidden" }}
            onScroll={onScroll}
            // Keeps focus in the field, so its blur doesn't close the list before a pick.
            onMouseDown={(e) => e.preventDefault()}
            className="fixed z-50 overflow-y-auto rounded-panel border border-line bg-surface py-1 shadow-lg"
          >
            {/* First, so the one-time notice is seen before the results it explains. */}
            {noticeDue && (
              <div
                className="space-y-1 border-b border-line px-3 pb-2 pt-1 text-footnote"
                data-testid="online-places-notice"
              >
                <p className="text-ink">{t("placeSearch.notice")}</p>
                <div className="flex gap-3">
                  <Button variant="link" size="sm" onClick={onlinePlaces.acknowledge}>
                    {t("placeSearch.gotIt")}
                  </Button>
                  <Button variant="link" size="sm" onClick={onlinePlaces.turnOff}>
                    {t("placeSearch.turnOff")}
                  </Button>
                </div>
              </div>
            )}
            <ul id={listId} role="listbox" aria-label={t("placePicker.listLabel")}>
              {options.map((option, i) => {
                const rowClass = i === active ? ROW_ACTIVE : ROW;
                if (option === ADD_TYPED)
                  return (
                    <li
                      key={ADD_TYPED}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === active}
                      onClick={() => choose(option)}
                      onMouseEnter={() => setHighlighted(i)}
                      className={`${rowClass} flex items-start gap-2 border-b border-line pb-2 text-accent`}
                    >
                      <PlusIcon className="mt-1 h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 break-words">{t("placePicker.addNamed", { name: typedName })}</span>
                    </li>
                  );
                if (option === NEW_PLACE)
                  return (
                    <li
                      key={NEW_PLACE}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === active}
                      onClick={() => choose(option)}
                      onMouseEnter={() => setHighlighted(i)}
                      className={`${rowClass} flex items-start gap-2 text-accent ${i > 0 ? "mt-1 border-t border-line pt-2" : ""}`}
                    >
                      <PlusIcon className="mt-1 h-3.5 w-3.5 shrink-0" />
                      {t("placePicker.newPlace")}
                    </li>
                  );
                const group = groupOf(option);
                const prior = options[i - 1];
                const previous = typeof prior === "object" ? prior : undefined;
                const heading =
                  group && group !== (previous && groupOf(previous))
                    ? group === ONLINE_GROUP
                      ? t("placeSearch.onlineResults")
                      : t(GROUP_KEY[group])
                    : null;
                const { name, second, privacy } = rowText(option);
                const nearby = option.kind !== "online" && option.group === "nearby" ? option.distanceM : null;
                return [
                  heading && (
                    <li
                      key={`h-${group}`}
                      role="presentation"
                      className="px-3 pb-1 pt-2 text-footnote font-semibold text-muted"
                    >
                      {heading}
                    </li>
                  ),
                  <li
                    key={`${option.kind}:${option.id}`}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    onClick={() => choose(option)}
                    onMouseEnter={() => setHighlighted(i)}
                    className={`${rowClass} flex items-start gap-3`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-ink">{name}</span>
                      {second && <span className="block break-words text-footnote text-muted">{second}</span>}
                      {privacy && <span className="block text-footnote text-muted">{privacy}</span>}
                    </span>
                    {nearby != null && (
                      <span className="shrink-0 text-footnote tabular-nums text-muted">{distance(nearby)}</span>
                    )}
                  </li>,
                ];
              })}
            </ul>
            {hasFooter && (
              <div className="space-y-1 border-t border-line px-3 pb-1 pt-2 text-footnote text-muted">
                {searching && <p>{t("placeSearch.searchingOnline")}</p>}
                {current?.failed && <p>{t("placeSearch.onlineUnavailable")}</p>}
                {fromOnline.length > 0 && <p>{t("placeSearch.credit", { credit: PHOTON_ATTRIBUTION })}</p>}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
