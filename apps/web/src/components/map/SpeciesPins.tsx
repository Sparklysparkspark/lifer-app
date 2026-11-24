import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { api, apiPath, type ApiResponse } from "../../api/client";
import { onAccountReset, onPhotosDeleted, useApiResource } from "../../lib/resource";
import { MOVED_PHOTOS_CHANGED } from "../../hooks/useMovedPhotos";
import { useLatest } from "../../hooks/useLatest";
import { formatNumber } from "../../lib/format";
import { useSpeciesName } from "../../lib/speciesName";
import { MAX_MARK_RADIUS, pickNearest, pickSlop, type PickCandidate } from "../../lib/mapPick";
import {
  PICKABLE,
  PIN_CLUSTERS,
  PIN_POINTS,
  PIN_RADIUS,
  PIN_SOURCE,
  addPinLayers,
  clusterSummary,
  highlightSpecies,
  pinClusterRadius,
  pinFeatures,
  showPins,
  zoomOntoCluster,
  type SpeciesPin,
} from "../../lib/mapSpeciesPins";
import { errorMessage } from "../../lib/errorMessage";
import { useToast } from "../../hooks/useToast";
import type { GalleryItem } from "../../pages/gallery/types";
import Button from "../Button";
import Lightbox, { type LightboxSlide } from "../Lightbox";
import ProgressiveImg from "../ProgressiveImg";
import { PointCard } from "../Tooltip";
import { gallerySlide } from "./gallerySlide";

type PinData = ApiResponse<"/collection/map">;
type Hover =
  | { kind: "pin"; x: number; y: number; pin: SpeciesPin }
  | {
      kind: "cluster";
      x: number;
      y: number;
      r: number;
      species: number;
      photos: number;
      top: SpeciesPin[];
      zoom: () => void;
    };

const HOVER_DELAY_MS = 200;
// After leaving a pin, this long to reach its card before it closes.
const CARD_GRACE_MS = 200;
// A click this soon after a pan or zoom ends is its tail, not a click.
const GESTURE_GRACE_MS = 250;
const CARD_PHOTOS = 6;
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

// One request per pin, however often it's opened, until the photos change.
const pinPhotos = new Map<string, Promise<GalleryItem[]>>();
const forgetPinPhotos = () => pinPhotos.clear();
onAccountReset(forgetPinPhotos);
onPhotosDeleted(forgetPinPhotos);
window.addEventListener(MOVED_PHOTOS_CHANGED, forgetPinPhotos);
function photosAt(regionId: string, pin: SpeciesPin): Promise<GalleryItem[]> {
  const q = { regionId, speciesId: pin.speciesId, lat: pin.lat, lon: pin.lon };
  const key = JSON.stringify(q);
  let found = pinPhotos.get(key);
  if (!found) {
    found = api.get(apiPath("/collection/map/photos", {}, q)).then((res) => res.items as GalleryItem[]);
    found.catch(() => pinPhotos.delete(key));
    pinPhotos.set(key, found);
  }
  return found;
}

/** Where in the region each species was photographed, on the Collection map: pins in the taxa
 *  colours that cluster as you zoom out. A pin previews its photos there; a cluster zooms in. */
export default function SpeciesPins({
  map,
  regionId,
  regionName,
  dark,
  speciesIds,
}: {
  /** The map once its style has loaded; null before. */
  map: MapLibreMap | null;
  regionId: string;
  regionName?: string;
  dark: boolean;
  /** The species the list shows, so the pins follow its filters; absent pins every one. */
  speciesIds?: ReadonlySet<string> | null;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const speciesName = useSpeciesName();
  // Mounted only while the View menu's Show map pins is on, so off asks for nothing.
  const { data } = useApiResource<PinData>(`/collection/map?regionId=${regionId}`);
  const pins = useMemo(() => {
    const all = (data?.pins ?? []) as SpeciesPin[];
    return speciesIds ? all.filter((p) => speciesIds.has(p.speciesId)) : all;
  }, [data, speciesIds]);
  const pinsRef = useLatest(pins);
  const [hover, setHover] = useState<Hover | null>(null);
  const cardRef = useRef({ enter: () => {}, leave: () => {} });
  // The species page stays one deliberate step away: the preview's View species, or the card's.
  const [preview, setPreview] = useState<{ items: GalleryItem[]; index: number } | null>(null);
  const openRef = useLatest((pin: SpeciesPin) =>
    photosAt(regionId, pin)
      .then((items) => items.length > 0 && setPreview({ items, index: 0 }))
      .catch((err) => toast.error(errorMessage(err, t("collection.map.photosFailed")))),
  );
  const rate = useLatest((captureId: string, rating: number | null) => {
    pinPhotos.clear();
    setPreview(
      (p) =>
        p && { ...p, items: p.items.map((i) => (i.captureId === captureId ? { ...i, qualityRating: rating } : i)) },
    );
    api
      .patch(apiPath("/captures/{id}/rating", { id: captureId }), { rating })
      .catch((err) => toast.error(errorMessage(err, t("gallery.map.rateFailed"))));
  });
  const slides = useMemo<LightboxSlide[]>(
    () =>
      (preview?.items ?? []).map((i) => gallerySlide(i, speciesName, (rating) => rate.current(i.captureId, rating))),
    [preview?.items, speciesName, rate],
  );

  // The parked map keeps its layers between visits.
  useEffect(() => {
    if (map && !map.getSource(PIN_SOURCE)) addPinLayers(map, dark);
  }, [map, dark]);
  useEffect(() => {
    (map?.getSource(PIN_SOURCE) as GeoJSONSource | undefined)?.setData(pinFeatures(pins) as never);
  }, [map, pins]);
  useEffect(() => {
    if (!map) return;
    showPins(map, true);
    return () => showPins(map, false);
  }, [map]);
  // A hovered pin rings the other pins of its species.
  const hoveredPin = hover?.kind === "pin" ? hover.pin.speciesId : null;
  useEffect(() => {
    if (map) highlightSpecies(map, hoveredPin);
  }, [map, hoveredPin]);

  useEffect(() => {
    if (!map) return;
    const canvas = map.getCanvas();
    type Hit = PickCandidate<{ layer: string; props: Record<string, unknown>; coords: [number, number] }>;
    const pickAt = (point: { x: number; y: number }, pointerType: string): Hit | null => {
      if (!map.getLayer(PIN_POINTS)) return null;
      const slop = pickSlop(pointerType, map.getZoom());
      const r = MAX_MARK_RADIUS + slop;
      const near = map.queryRenderedFeatures(
        [
          [point.x - r, point.y - r],
          [point.x + r, point.y + r],
        ],
        { layers: PICKABLE },
      );
      const candidates = near.map((f): Hit => {
        const coords = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
        const at = map.project(coords);
        const props = (f.properties ?? {}) as Record<string, unknown>;
        const cluster = f.layer.id === PIN_CLUSTERS;
        return {
          kind: cluster ? "cluster" : "point",
          x: at.x,
          y: at.y,
          radius: cluster ? pinClusterRadius(Number(props.point_count)) : PIN_RADIUS,
          data: { layer: f.layer.id, props, coords },
        };
      });
      return pickNearest(candidates, point.x, point.y, slop);
    };

    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let shownKey = "";
    let overCard = false;
    const hide = () => {
      clearTimeout(hoverTimer);
      clearTimeout(closeTimer);
      shownKey = "";
      overCard = false;
      setHover(null);
    };
    const closeSoon = () => {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => !overCard && hide(), CARD_GRACE_MS);
    };
    cardRef.current = {
      enter: () => {
        overCard = true;
        clearTimeout(closeTimer);
      },
      leave: () => {
        overCard = false;
        closeSoon();
      },
    };
    const zoomOnto = (hit: Hit) => {
      const source = map.getSource(PIN_SOURCE) as GeoJSONSource;
      void source
        .getClusterExpansionZoom(Number(hit.data.props.cluster_id))
        .then(
          (zoom) => zoom,
          () => null,
        )
        .then((zoom) => zoomOntoCluster(map, hit.data.coords, zoom, reducedMotion()));
    };
    const preview = async (hit: Hit) => {
      const box = canvas.getBoundingClientRect();
      const x = box.left + hit.x;
      const y = box.top + hit.y;
      if (hit.kind === "point") {
        const pin = pinsRef.current[Number(hit.data.props.i)];
        if (pin) setHover({ kind: "pin", x, y, pin });
        return;
      }
      const source = map.getSource(PIN_SOURCE) as GeoJSONSource;
      const zoom = () => {
        setHover(null);
        zoomOnto(hit);
      };
      const leaves = await source.getClusterLeaves(Number(hit.data.props.cluster_id), Infinity, 0);
      const leafPins = leaves.map((l) => pinsRef.current[Number(l.properties?.i)]).filter(Boolean);
      const seen = new Set<string>();
      // Each species' biggest pin here, one thumbnail per species.
      const top = [...leafPins]
        .sort((a, b) => b.count - a.count)
        .filter((p) => !seen.has(p.speciesId) && seen.add(p.speciesId))
        .slice(0, CARD_PHOTOS);
      setHover({ kind: "cluster", x, y, r: hit.radius, ...clusterSummary(leafPins), top, zoom });
    };
    const hoverAt = (point: { x: number; y: number }, pointerType: string) => {
      const hit = pickAt(point, pointerType);
      canvas.style.cursor = hit ? "pointer" : "";
      const key = hit ? `${hit.data.layer}:${hit.data.props.cluster_id ?? hit.data.props.i}` : "";
      if (key === shownKey) return clearTimeout(closeTimer);
      shownKey = key;
      clearTimeout(hoverTimer);
      if (!hit) return closeSoon();
      hoverTimer = setTimeout(() => {
        clearTimeout(closeTimer);
        void preview(hit).catch(() => setHover(null));
      }, HOVER_DELAY_MS);
    };

    // A drag, pinch or scroll-zoom is never a click (MapLibre still sends one after a small drag).
    let down: { x: number; y: number; touch: boolean } | null = null;
    let gestureEnded = 0;
    const onPointerDown = (ev: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      down = { x: ev.clientX - box.left, y: ev.clientY - box.top, touch: ev.pointerType !== "mouse" };
    };
    const onMoveEnd = (e: { originalEvent?: Event }) => {
      if (e.originalEvent) gestureEnded = performance.now();
    };
    const isClick = (point: { x: number; y: number }) =>
      !map.isMoving() &&
      performance.now() - gestureEnded > GESTURE_GRACE_MS &&
      (!down || Math.hypot(point.x - down.x, point.y - down.y) <= (down.touch ? 10 : 4));
    const onMouseMove = (e: MapMouseEvent) => {
      if (map.isMoving() || (e.originalEvent?.buttons ?? 0) > 0) return hide();
      hoverAt(e.point, (e.originalEvent as PointerEvent | undefined)?.pointerType ?? "mouse");
    };
    const onLeave = () => {
      clearTimeout(hoverTimer);
      shownKey = "";
      canvas.style.cursor = "";
      closeSoon();
    };
    const onClick = (e: MapMouseEvent) => {
      hide();
      if (!isClick(e.point)) return;
      const touch = down?.touch ?? false;
      const hit = pickAt(e.point, touch ? "touch" : "mouse");
      if (!hit) return;
      if (hit.kind === "point") {
        const pin = pinsRef.current[Number(hit.data.props.i)];
        if (pin) void openRef.current(pin);
        return;
      }
      zoomOnto(hit);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("mouseleave", onLeave);
    map.on("mousemove", onMouseMove);
    map.on("click", onClick);
    map.on("moveend", onMoveEnd);
    map.on("movestart", hide);
    return () => {
      hide();
      canvas.style.cursor = "";
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("mouseleave", onLeave);
      map.off("mousemove", onMouseMove);
      map.off("click", onClick);
      map.off("moveend", onMoveEnd);
      map.off("movestart", hide);
    };
  }, [map, pinsRef, openRef]);

  const clusterTitle = (h: { species: number; top: SpeciesPin[] }) =>
    h.species === 1 && h.top[0]
      ? speciesName(h.top[0])
      : t("collection.map.speciesHere", { count: h.species, formatted: formatNumber(h.species) });
  const photosHere = (n: number) => t("collection.map.photosHere", { count: n, formatted: formatNumber(n) });

  return (
    <>
      {/* Only when nothing at all is placed; a filter that hides every pin isn't "no pins yet". */}
      {data && (data.pins ?? []).length === 0 && (
        <p
          className="absolute left-2 top-2 max-w-[calc(100%-1rem)] rounded-control bg-surface/90 px-2.5 py-1.5 text-footnote text-muted shadow-sm"
          data-testid="species-pins-empty"
        >
          <Trans
            i18nKey="collection.map.noPins"
            components={{ placeLink: <Link to="/gallery?view=map&at=tray" className="text-link underline" /> }}
          />
        </p>
      )}
      {hover?.kind === "pin" && (
        <PointCard
          x={hover.x}
          y={hover.y}
          avoid={PIN_RADIUS + 4}
          label={speciesName(hover.pin)}
          onPointerEnter={() => cardRef.current.enter()}
          onPointerLeave={() => cardRef.current.leave()}
        >
          <div className="flex w-60 items-start gap-2.5" data-testid="species-pin-card">
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("collection.map.openPhotos", { name: speciesName(hover.pin) })}
              onClick={() => void openRef.current(hover.pin)}
              className="h-14! w-14! shrink-0 overflow-hidden p-0!"
            >
              <ProgressiveImg
                thumbSrc={`/api/photos/${hover.pin.photoId}/thumb`}
                alt=""
                className="h-full w-full object-cover"
              />
            </Button>
            <span className="min-w-0">
              <span className="block break-words font-medium">{speciesName(hover.pin)}</span>
              <span className="block text-muted">{photosHere(hover.pin.count)}</span>
              <Link
                to={`/species/${hover.pin.speciesId}?regionId=${regionId}`}
                state={{ backLabel: regionName ?? t("nav.collection") }}
                className="text-link underline"
              >
                {t("collection.map.viewSpecies")}
              </Link>
            </span>
          </div>
        </PointCard>
      )}
      {hover?.kind === "cluster" && (
        // One line: one species is named with its photos; several are counted.
        <PointCard
          x={hover.x}
          y={hover.y}
          avoid={hover.r + 4}
          label={clusterTitle(hover)}
          onPointerEnter={() => cardRef.current.enter()}
          onPointerLeave={() => cardRef.current.leave()}
        >
          <div className="space-y-1.5" data-testid="species-cluster-card">
            <p className="break-words font-medium">{clusterTitle(hover)}</p>
            {hover.species === 1 && <p className="text-muted">{photosHere(hover.photos)}</p>}
            <div className="grid w-60 grid-cols-3 gap-1">
              {/* Past six species the last cell is "+N", zooming in as a click on the cluster does. */}
              {hover.top.slice(0, hover.species > CARD_PHOTOS ? CARD_PHOTOS - 1 : CARD_PHOTOS).map((pin) => (
                <Button
                  key={pin.speciesId}
                  variant="ghost"
                  size="sm"
                  aria-label={t("collection.map.openPhotos", { name: speciesName(pin) })}
                  tooltip={{ label: speciesName(pin) }}
                  onClick={() => void openRef.current(pin)}
                  className="aspect-square h-auto! overflow-hidden p-0!"
                >
                  <ProgressiveImg
                    thumbSrc={`/api/photos/${pin.photoId}/thumb`}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </Button>
              ))}
              {hover.species > CARD_PHOTOS && (
                <Button variant="secondary" size="sm" onClick={hover.zoom} className="aspect-square h-auto!">
                  {t("gallery.map.card.more", {
                    count: hover.species - (CARD_PHOTOS - 1),
                    formatted: formatNumber(hover.species - (CARD_PHOTOS - 1)),
                  })}
                </Button>
              )}
            </div>
          </div>
        </PointCard>
      )}
      {preview && (
        <Lightbox
          slides={slides}
          index={preview.index}
          onIndexChange={(index) => setPreview((p) => p && { ...p, index })}
          onClose={() => setPreview(null)}
          backLabel={regionName}
        />
      )}
    </>
  );
}
