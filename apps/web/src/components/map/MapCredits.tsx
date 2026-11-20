import { useEffect, useRef, useState } from "react";
import { useEscapeToClose } from "../../hooks/useEscapeToClose";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import type { IControl, Map as MapLibreMap } from "maplibre-gl";
import { IconButton } from "../Button";
import { activeCredits, alsoUsedCredits, mapPanelBox, OSM_CREDIT, type Credit } from "../../lib/mapCredits";
import { openExternal } from "../../lib/openExternal";
import { useExclusiveOpen } from "../../lib/exclusivePopover";
import MapOnlineDetail from "./MapOnlineDetail";
import MapLayersControl from "./MapLayersControl";

const HOVER_OPEN_MS = 300;
// Long enough to cross from the button into the panel.
const CLOSE_GRACE_MS = 200;
// OSM's attribution guidelines: the credit is seen without any interaction at first, and may then
// collapse after five seconds or on map interaction, once per session.
const START_CREDIT_MS = 5000;
let startCreditShown = false;

function InfoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

function CreditList({ credits }: { credits: Credit[] }) {
  return (
    <ul className="space-y-2">
      {credits.map((c) => (
        <li key={c.key} className="text-footnote text-muted">
          <a
            href={c.href}
            onClick={(e) => {
              e.preventDefault();
              openExternal(c.href);
            }}
            className="block font-medium text-link hover:underline"
          >
            {c.name}
          </a>
          {c.text}
          {c.licence && (
            <>
              {" "}
              <a
                href={c.licence.href}
                onClick={(e) => {
                  e.preventDefault();
                  openExternal(c.licence!.href);
                }}
                className="text-link hover:underline"
              >
                {c.licence.name}
              </a>
            </>
          )}
          {c.lines && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {c.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The map's credits behind a small info button in the bottom-right corner: every source's full
 *  citation, those on screen first. It opens on a click, Enter or Space, or a short mouse hover, and
 *  goes as soon as it's left: the pointer off both the button and the panel (a short grace lets it
 *  cross between them), keyboard focus out of both, a click elsewhere, Esc, or the map moving. The
 *  panel is portaled to the page, so a small map (a dialog, the placing card) never clips it. */
export function MapCredits({ map, placeSearch = false }: { map: MapLibreMap; placeSearch?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // How it was opened: a touch has no hover, so only a tap elsewhere, Esc or a move closes it.
  const [touch, setTouch] = useState(false);
  const [overButton, setOverButton] = useState(false);
  const [overPanel, setOverPanel] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState<Credit[]>([]);
  const [box, setBox] = useState<ReturnType<typeof mapPanelBox> | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastPointer = useRef<string>("mouse");
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [startCredit, setStartCredit] = useState(() => !startCreditShown);
  // Opening another popover or menu (the layers panel) closes this one, and the other way round.
  useExclusiveOpen(open, () => setOpen(false));
  useEscapeToClose(() => setOpen(false), open);

  useEffect(() => {
    if (!startCredit) return;
    startCreditShown = true;
    const hide = () => setStartCredit(false);
    const timer = setTimeout(hide, START_CREDIT_MS);
    map.on("movestart", hide);
    return () => {
      clearTimeout(timer);
      map.off("movestart", hide);
    };
  }, [map, startCredit]);

  // What's on screen changes as layers come and go or the zoom crosses a layer's range.
  useEffect(() => {
    const update = () => setActive(activeCredits(map, { placeSearch }));
    for (const ev of ["load", "styledata", "zoomend"] as const) map.on(ev, update);
    if (map.isStyleLoaded?.()) update();
    return () => {
      for (const ev of ["load", "styledata", "zoomend"] as const) map.off(ev, update);
    };
  }, [map, placeSearch]);

  // Esc, a click outside both, or the map moving closes it; the panel follows its button.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!wrapRef.current?.contains(target) && !panelRef.current?.contains(target)) close();
    };
    const place = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setBox(mapPanelBox(r, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    map.on("movestart", close);
    document.addEventListener("click", outside);
    window.addEventListener("resize", place);
    return () => {
      map.off("movestart", close);
      document.removeEventListener("click", outside);
      window.removeEventListener("resize", place);
    };
  }, [map, open]);

  // Left: gone after a short grace, so moving from the button into the panel doesn't flicker.
  useEffect(() => {
    if (!open || touch || overButton || overPanel || focused) return;
    const timer = setTimeout(() => setOpen(false), CLOSE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [open, touch, overButton, overPanel, focused]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const show = (byTouch: boolean) => {
    clearTimeout(hoverTimer.current);
    setTouch(byTouch);
    setOpen(true);
  };
  // Only keyboard focus holds it open: a click leaves focus on the button, which would pin it.
  const focusHandlers = {
    onFocus: (e: React.FocusEvent) => {
      if ((e.target as Element).matches(":focus-visible")) setFocused(true);
    },
    onBlur: (e: React.FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (!wrapRef.current?.contains(next) && !panelRef.current?.contains(next)) setFocused(false);
    },
  };
  const mouseOnly = (set: (v: boolean) => void, v: boolean) => (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") set(v);
  };

  const also = alsoUsedCredits(active);
  const osm = active.some((c) => c.key === "osm");
  return (
    <div
      ref={wrapRef}
      data-testid="map-credits"
      className="flex items-center gap-1.5"
      onPointerDown={(e) => (lastPointer.current = e.pointerType)}
      onPointerEnter={(e) => {
        if (e.pointerType !== "mouse") return;
        setOverButton(true);
        if (!open) hoverTimer.current = setTimeout(() => show(false), HOVER_OPEN_MS);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "mouse") return;
        clearTimeout(hoverTimer.current);
        setOverButton(false);
      }}
      {...focusHandlers}
    >
      {startCredit && osm && !open && (
        <span className="rounded-badge bg-surface/85 px-1.5 py-0.5 text-caption text-ink">{OSM_CREDIT}</span>
      )}
      <IconButton
        aria-label={t("mapCredits.title")}
        aria-expanded={open}
        tooltip={{ label: t("mapCredits.title") }}
        // A quiet disc, like the layers button but translucent so it never draws the eye.
        className="bg-control/80 text-muted hover:text-ink"
        onClick={(e) => {
          if (open) return setOpen(false);
          show(lastPointer.current === "touch" || lastPointer.current === "pen");
          // Opened from the keyboard: focus goes into the panel, so it stays while read.
          if (e.detail === 0) requestAnimationFrame(() => panelRef.current?.focus());
        }}
      >
        <InfoIcon />
      </IconButton>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            tabIndex={-1}
            role="region"
            aria-label={t("mapCredits.title")}
            data-testid="map-credits-panel"
            style={box ?? { visibility: "hidden" }}
            onPointerEnter={mouseOnly(setOverPanel, true)}
            onPointerLeave={mouseOnly(setOverPanel, false)}
            {...focusHandlers}
            className="fixed z-50 space-y-3 overflow-y-auto rounded-panel border border-line bg-surface p-3 shadow-lg"
          >
            <p className="text-footnote font-semibold text-ink">{t("mapCredits.title")}</p>
            <CreditList credits={active} />
            {also.length > 0 && (
              <>
                <p className="text-footnote font-semibold text-ink">{t("mapCredits.alsoUsed")}</p>
                <CreditList credits={also} />
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

class CreditsControl implements IControl {
  private el = document.createElement("div");
  private root = createRoot(this.el);
  constructor(private options: { placeSearch: boolean; satellite: boolean }) {}
  onAdd(map: MapLibreMap) {
    // In line with the layers button at the top right (right-3).
    this.el.className = "maplibregl-ctrl m-0! mb-3! mr-3!";
    this.root.render(
      <>
        <MapCredits map={map} placeSearch={this.options.placeSearch} />
        <MapOnlineDetail map={map} satellite={this.options.satellite} />
      </>,
    );
    return this.el;
  }
  onRemove() {
    // The map is often removed during a React commit; unmounting then would warn.
    queueMicrotask(() => this.root.unmount());
    this.el.remove();
  }
}

// The layers button in the top-right corner, for maps that offer satellite.
class LayersControl implements IControl {
  private el = document.createElement("div");
  private root = createRoot(this.el);
  constructor(private places: boolean) {}
  onAdd(map: MapLibreMap) {
    // Hovering or focusing the map reveals the button.
    map.getContainer().classList.add("group");
    this.el.className = "maplibregl-ctrl m-0! mr-3! mt-3!";
    this.root.render(<MapLayersControl map={map} reveal places={this.places} />);
    return this.el;
  }
  onRemove() {
    queueMicrotask(() => this.root.unmount());
    this.el.remove();
  }
}

/** Adds the credits button and online detail to a map built with `attributionControl: false`, and,
 *  with `satellite` (maps where photos are placed or browsed), the layers button for Map, Satellite
 *  and online detail. Other maps only get the sharper map. One call per map, so no page mounts its
 *  own copy. `placeSearch`: the map has place search (Photon's credit, the online places switch). */
export function addMapCredits(map: MapLibreMap, { placeSearch = false, satellite = false } = {}): void {
  map.addControl(new CreditsControl({ placeSearch, satellite }), "bottom-right");
  if (satellite) map.addControl(new LayersControl(placeSearch), "top-right");
}
