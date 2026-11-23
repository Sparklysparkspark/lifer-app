import { useEffect, useMemo, useState } from "react";
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { useApiResource } from "../../lib/resource";
import { useLatest } from "../../hooks/useLatest";
import { MAX_MARK_RADIUS, pickSlop } from "../../lib/mapPick";
import { PICKABLE } from "../../lib/mapSpeciesPins";
import {
  AREA_FILL,
  AREA_SOURCE,
  addAreaOutlineLayers,
  areaOutlineFeatures,
  highlightedArea,
  setAreaOutlines,
} from "../../lib/mapAreaOutlines";
import { PointTooltip } from "../Tooltip";

export interface AreaOutlinesProps {
  /** The region whose areas these are. */
  regionId: string;
  /** The areas its pills list (regionCollapse's areasOf), each with the id it opens. */
  areas: ReadonlyArray<{ id: string; name: string }>;
  /** regionCollapse's target, to tie an outline to its pill. */
  target: (id: string) => string;
  onOpen: (id: string) => void;
}

type Boundaries = { regions: Array<{ id: string; parentId: string | null; boundaryGeoJson: { geometry?: unknown } }> };

/** The region's areas as muted outlines: pointing at one names it and lights its pill (and the
 *  reverse), and clicking one opens it like its pill. Pins keep the pointer where they are. */
export default function AreaOutlines({
  map,
  regionId,
  areas,
  target,
  onOpen,
}: AreaOutlinesProps & { map: MapLibreMap | null }) {
  const { data } = useApiResource<Boundaries>(`/regions/boundaries?parentId=${regionId}`);
  const features = useMemo(
    () => areaOutlineFeatures(data?.regions ?? [], regionId, areas, target),
    [data, regionId, areas, target],
  );
  const names = useLatest(new Map(areas.map((a) => [a.id, a.name])));
  const onOpenRef = useLatest(onOpen);
  const highlighted = highlightedArea.use();
  // Where the pointer is, while it's over an area.
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  // The parked map keeps its layers between visits; leaving clears them.
  useEffect(() => {
    if (!map) return;
    if (!map.getSource(AREA_SOURCE)) addAreaOutlineLayers(map);
    setAreaOutlines(map, features);
  }, [map, features]);
  useEffect(() => () => void (map && setAreaOutlines(map, areaOutlineFeatures([], "", [], String))), [map]);

  useEffect(() => {
    if (!map || !highlighted) return;
    const feature = { source: AREA_SOURCE, id: highlighted };
    map.setFeatureState(feature, { hover: true });
    return () => void map.setFeatureState(feature, { hover: false });
  }, [map, highlighted, features]);

  useEffect(() => {
    if (!map) return;
    const canvas = map.getCanvasContainer();
    const areaAt = (point: { x: number; y: number }, pointerType: string): string | null => {
      if (!map.getLayer(AREA_FILL)) return null;
      // A pin there wins: it has its own hover and click.
      const r = MAX_MARK_RADIUS + pickSlop(pointerType, map.getZoom());
      const pins = PICKABLE.filter((id) => map.getLayer(id));
      const box: [[number, number], [number, number]] = [
        [point.x - r, point.y - r],
        [point.x + r, point.y + r],
      ];
      if (pins.length && map.queryRenderedFeatures(box, { layers: pins }).length) return null;
      const hit = map.queryRenderedFeatures([point.x, point.y], { layers: [AREA_FILL] })[0];
      return (hit?.properties?.area as string | undefined) ?? null;
    };
    const clear = () => {
      canvas.style.cursor = "";
      setPointer(null);
      highlightedArea.set(null);
    };
    // A drag is never a click (MapLibre still sends one after a small drag).
    let down: { x: number; y: number; touch: boolean } | null = null;
    const onPointerDown = (ev: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      down = { x: ev.clientX - box.left, y: ev.clientY - box.top, touch: ev.pointerType !== "mouse" };
    };
    const onMouseMove = (e: MapMouseEvent) => {
      if (map.isMoving() || (e.originalEvent?.buttons ?? 0) > 0) return clear();
      const area = areaAt(e.point, "mouse");
      if (!area) return clear();
      // The container's cursor, so a pin's own cursor on the canvas still shows over it.
      canvas.style.cursor = "pointer";
      const box = canvas.getBoundingClientRect();
      setPointer({ x: box.left + e.point.x, y: box.top + e.point.y });
      highlightedArea.set(area);
    };
    const onClick = (e: MapMouseEvent) => {
      const touch = down?.touch ?? false;
      if (map.isMoving() || (down && Math.hypot(e.point.x - down.x, e.point.y - down.y) > (touch ? 10 : 4))) return;
      const area = areaAt(e.point, touch ? "touch" : "mouse");
      if (!area) return;
      clear();
      onOpenRef.current(area);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("mouseleave", clear);
    map.on("mousemove", onMouseMove);
    map.on("click", onClick);
    map.on("movestart", clear);
    return () => {
      clear();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("mouseleave", clear);
      map.off("mousemove", onMouseMove);
      map.off("click", onClick);
      map.off("movestart", clear);
    };
  }, [map, onOpenRef]);

  const name = highlighted && pointer ? names.current.get(highlighted) : undefined;
  return name ? (
    <PointTooltip x={pointer!.x} y={pointer!.y}>
      <span className="break-words" data-testid="area-outline-name">
        {name}
      </span>
    </PointTooltip>
  ) : null;
}
