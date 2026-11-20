import { useEffect } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { curatedPitch, type TiltMode } from "../lib/mapCamera";

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** The map's one 3D look: after each move it eases to the curated pitch once zoomed in (Auto, with
 *  relief) and back to flat when zoomed out or set to Flat. A jump with reduced motion. The map
 *  itself takes no tilt or rotation gestures (PhotoMap's map options). */
export function useCuratedTilt(map: MapLibreMap | null, mode: TiltMode, relief: boolean): void {
  useEffect(() => {
    if (!map) return;
    const follow = () => {
      const target = curatedPitch(map.getZoom(), map.getPitch() > 0, mode, relief);
      if (Math.abs(map.getPitch() - target) > 0.5)
        map.easeTo({ pitch: target, bearing: 0, duration: reducedMotion() ? 0 : 500 });
    };
    follow();
    map.on("moveend", follow);
    return () => void map.off("moveend", follow);
  }, [map, mode, relief]);
}
