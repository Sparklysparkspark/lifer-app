import { useEffect, useSyncExternalStore } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { publishOnlineState, useOnlineBasemap, useOnlineMapPrefs } from "../../hooks/useOnlineMap";
import { useMapAvailable } from "../../hooks/useMapAvailable";

const loadedMaps = new WeakSet<MapLibreMap>();

/** Online detail (and satellite, where the map allows it) for one map, from the shared choices.
 *  Added to every map with its credits, so no map is left on blurry tiles; the layers button, where
 *  there is one, only reads what this publishes. */
export default function MapOnlineDetail({ map, satellite }: { map: MapLibreMap; satellite: boolean }) {
  const prefs = useOnlineMapPrefs();
  // Without the bundled basemap the land is an opaque fill, so online tiles would load unseen.
  const available = useMapAvailable() === true;
  // Online layers go in once the style has loaded, whenever that was.
  const ready = useSyncExternalStore(
    (changed) => {
      map.on("styledata", changed);
      map.on("load", changed);
      return () => {
        map.off("styledata", changed);
        map.off("load", changed);
      };
    },
    // Latched: adding the online sources makes the style "not loaded" again while they load, and
    // following that would take them straight back out.
    () => loadedMaps.has(map) || (!!map.isStyleLoaded?.() && !!loadedMaps.add(map)),
  );
  const { mode, failed, slow } = useOnlineBasemap(
    available && ready ? map : null,
    satellite ? prefs : { ...prefs, base: "map" },
  );
  useEffect(() => publishOnlineState(map, { mode, failed, slow }), [map, mode, failed, slow]);
  return null;
}
