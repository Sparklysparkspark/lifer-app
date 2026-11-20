import type { Map as MapLibreMap } from "maplibre-gl";
import { easeOut, zoomAnchor } from "./mapCamera";

/** One eased move that brings `lngLat` to the centre of the map while zooming to `zoom`, with
 *  the point staying on screen and sliding straight to the centre the whole way (zoomAnchor),
 *  instead of a centre pan that the zoom outruns. A pan limit is lifted for the move, so it can't
 *  bend the path, and put back afterwards widened to hold where it ended. */
export function zoomOnto(
  map: MapLibreMap,
  lngLat: [number, number],
  { zoom, duration }: { zoom: number; duration: number },
): void {
  const box = map.getContainer();
  const centre: [number, number] = [box.clientWidth / 2, box.clientHeight / 2];
  // The copy of the point (the world repeats sideways) nearest the centre.
  const [lon, lat] = lngLat;
  const at = [lon - 360, lon, lon + 360]
    .map((l) => ({ l, p: map.project([l, lat]) }))
    .reduce((a, b) =>
      Math.hypot(b.p.x - centre[0], b.p.y - centre[1]) < Math.hypot(a.p.x - centre[0], a.p.y - centre[1]) ? b : a,
    );
  const limit = map.getMaxBounds();
  if (limit) {
    map.setMaxBounds(null);
    map.once("moveend", () => map.setMaxBounds(limit.extend(map.getBounds())));
  }
  const anchor = duration > 0 ? zoomAnchor([at.p.x, at.p.y], centre, zoom - map.getZoom()) : null;
  if (!anchor) {
    map.easeTo({ center: [at.l, lat], zoom, bearing: 0, duration, easing: easeOut });
    return;
  }
  map.easeTo({ zoom, around: map.unproject(anchor), bearing: 0, duration, easing: easeOut });
}
