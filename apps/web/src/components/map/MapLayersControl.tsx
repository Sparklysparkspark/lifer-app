import { useEffect, useRef, useState } from "react";
import { useEscapeToClose } from "../../hooks/useEscapeToClose";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Map as MapLibreMap } from "maplibre-gl";
import { IconButton } from "../Button";
import SegmentedControl from "../SegmentedControl";
import { useOnlineBasemapState, useOnlineMapPrefs, type OnlineMapPrefs } from "../../hooks/useOnlineMap";
import { useMapAvailable } from "../../hooks/useMapAvailable";
import { useOnlinePlaces } from "../../hooks/useOnlinePlaces";
import { useExclusiveOpen } from "../../lib/exclusivePopover";
import { mapPanelBox } from "../../lib/mapCredits";
import { publishMapControlSlot } from "../../lib/mapControlSlot";
import { customSatelliteUrl, providerNames } from "../../lib/mapStyle";

/** A stack of map sheets, with a small accent dot while online tiles are in use. */
function LayersIcon({ online }: { online: boolean }) {
  return (
    <span className="relative inline-flex">
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m12 3 9 5-9 5-9-5 9-5Z" />
        <path d="m3 13 9 5 9-5" />
      </svg>
      {online && (
        <span
          className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-accent ring-1 ring-control"
          data-testid="layers-online-dot"
        />
      )}
    </span>
  );
}

// Fades in while the map (its container has the `group` class) is hovered or holds keyboard focus,
// and stays while its panel is open; always shown on touch screens, which have no hover. Not
// focus-within: a click on the map focuses its canvas, which would keep the controls shown.
const SHOWN = "pointer-fine:group-hover:opacity-100 pointer-fine:group-has-[:focus-visible]:opacity-100";
const REVEAL = `pointer-fine:opacity-0 ${SHOWN} pointer-fine:has-[[aria-expanded=true]]:opacity-100`;
// A page's own controls fade with it and can't be clicked while faded, but stay in the tab order:
// the first Tab into the map lands on them (Reset view) and its focus-visible shows the row.
const SLOT_REVEAL = `transition-opacity duration-200 pointer-fine:opacity-0 pointer-fine:pointer-events-none ${SHOWN} pointer-fine:group-hover:pointer-events-auto pointer-fine:group-has-[:focus-visible]:pointer-events-auto`;

/** A map's layers button (Map or Satellite, and whether online detail loads by itself). Detail loads
 *  only when zoomed in and online, unless turned off. Every map shares the same remembered choices.
 *  What each choice sends is said once, inside the panel. */
export default function MapLayersControl({
  map,
  reveal = false,
  places = true,
}: {
  map: MapLibreMap | null;
  /** Show the button only on hover or focus (an ancestor needs the `group` class). */
  reveal?: boolean;
  /** Offer the online place search switch, on maps that have place search. */
  places?: boolean;
}) {
  const { t } = useTranslation();
  const prefs = useOnlineMapPrefs();
  // Without the bundled basemap there is nothing to switch.
  const available = useMapAvailable() === true;
  // Applied by the map's own MapOnlineDetail (added with its credits); this only shows it.
  const { mode, failed, slow } = useOnlineBasemapState(map);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<ReturnType<typeof mapPanelBox> | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Opening another popover or menu (the credits panel) closes this one, and the other way round.
  useExclusiveOpen(open, () => setOpen(false));
  useEscapeToClose(() => setOpen(false), open);

  // Esc or a click outside both closes it; the panel follows its button.
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!wrapRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const place = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setBox(mapPanelBox(r, { width: window.innerWidth, height: window.innerHeight }, { prefer: "below" }));
    };
    place();
    document.addEventListener("click", outside);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("click", outside);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  if (!available) return null;
  return (
    <div className="flex max-w-full flex-col items-end gap-1">
      <div className="flex items-start gap-2">
        {/* A page's own controls (Reset view) go here, left of the layers button, in one row. */}
        <div
          ref={(el) => {
            if (map) publishMapControlSlot(map, el);
          }}
          data-testid="map-control-slot"
          className={`flex items-center gap-2 empty:hidden ${reveal ? SLOT_REVEAL : ""}`}
        />
        {/* Fades in on hover or focus; the open state keeps it (has aria-expanded=true). */}
        <div ref={wrapRef} className={`transition-opacity duration-200 ${reveal ? REVEAL : ""}`}>
          <IconButton
            aria-label={t("gallery.map.layers.button")}
            aria-expanded={open}
            tooltip={{ label: t("gallery.map.layers.button") }}
            onClick={() => setOpen(!open)}
          >
            <LayersIcon online={mode !== null} />
          </IconButton>
        </div>
      </div>
      {/* Under the button's slot, which stays reserved while the button is faded out, so the line
          never moves with hover; hidden while the panel is open. */}
      {failed && !open && (
        <p
          role="status"
          data-testid="map-layers-failed"
          className="max-w-60 rounded-badge bg-surface/85 px-1.5 py-0.5 text-right text-caption text-muted"
        >
          {t("gallery.map.layers.failed")}
        </p>
      )}
      {/* A slow connection: detail is on its way, the offline map shows meanwhile. */}
      {slow && !failed && !open && (
        <p
          role="status"
          data-testid="map-layers-slow"
          className="max-w-60 rounded-badge bg-surface/85 px-1.5 py-0.5 text-right text-caption text-muted"
        >
          {t("gallery.map.layers.slow")}
        </p>
      )}
      {open &&
        // On the page, not in the map, so a small map or a dialog never clips it.
        createPortal(
          <div
            ref={panelRef}
            role="region"
            aria-label={t("gallery.map.layers.button")}
            data-testid="map-layers-panel"
            style={box ?? { visibility: "hidden" }}
            className="fixed z-50 overflow-y-auto rounded-panel border border-line bg-surface p-3 shadow-lg"
          >
            <LayersPanel prefs={prefs} places={places} />
          </div>,
          document.body,
        )}
    </div>
  );
}

export function LayersPanel({ prefs, places = true }: { prefs: OnlineMapPrefs; places?: boolean }) {
  const { t } = useTranslation();
  const providers = providerNames(prefs.satelliteUrl);
  const satellite = prefs.base === "satellite";
  return (
    <div className="space-y-3">
      <SegmentedControl
        label={t("gallery.map.layers.baseLabel")}
        value={prefs.base}
        onChange={prefs.setBase}
        options={[
          { value: "map", label: t("gallery.map.layers.map") },
          { value: "satellite", label: t("gallery.map.layers.satellite") },
        ]}
      />
      {satellite ? (
        <div className="space-y-1">
          <p className="text-footnote text-muted">{t("gallery.map.layers.satelliteNote", providers)}</p>
          {!customSatelliteUrl(prefs.satelliteUrl) && (
            <p className="text-footnote text-muted">{t("gallery.map.layers.imageryLimit")}</p>
          )}
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="text-callout text-ink">{t("gallery.map.layers.online")}</p>
          <SegmentedControl
            label={t("gallery.map.layers.online")}
            value={prefs.detail}
            onChange={prefs.setDetail}
            options={[
              { value: "auto", label: t("gallery.map.layers.auto") },
              { value: "off", label: t("gallery.map.layers.off") },
            ]}
          />
          <p className="text-footnote text-muted">
            {prefs.detail === "auto" ? t("gallery.map.layers.detailNote", providers) : t("gallery.map.layers.offNote")}
          </p>
        </div>
      )}
      {places && (
        <div className="space-y-1.5 border-t border-line pt-3">
          <p className="text-callout text-ink">{t("settings.general.map.places")}</p>
          <OnlinePlacesChoice />
        </div>
      )}
    </div>
  );
}

/** Automatic or Off for online place search and names, here and in Settings. */
export function OnlinePlacesChoice() {
  const { t } = useTranslation();
  const places = useOnlinePlaces();
  return (
    <SegmentedControl
      label={t("settings.general.map.places")}
      value={places.setting}
      onChange={places.setSetting}
      options={[
        { value: "auto", label: t("gallery.map.layers.auto") },
        { value: "off", label: t("gallery.map.layers.off") },
      ]}
    />
  );
}
