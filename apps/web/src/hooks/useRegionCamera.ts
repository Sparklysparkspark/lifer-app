import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, PaddingOptions } from "maplibre-gl";
import { matches } from "../lib/keymap";
import {
  easeOut,
  FIT_PADDING,
  panLimits,
  partFraming,
  regionCamera,
  regionFraming,
  zoomFloor,
  type Framing,
} from "../lib/mapCamera";
import { hideRegionOutline, showRegionOutline } from "../lib/mapRegionLayers";
import {
  KEY_LEVELS,
  NO_OVERSHOOT,
  OVERSHOOT,
  overshootStep,
  pinchLevels,
  wheelLevels,
  type OvershootInput,
} from "../lib/zoomOvershoot";
import { setTerrainExaggeration } from "../lib/pmtiles";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useLatest } from "./useLatest";

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** The curated region view on a big map. `enter` flies to a country's or province's fixed framing
 *  (or one of its far parts), north up and tilted only when `tiltAt(zoom)` says the landing zoom
 *  gets the curated 3D look; it dims the world around the region and holds pan and zoom-out near
 *  the framing. `reset` (also Mod+0) returns to the framing; `leave` lifts the limits and clears the
 *  dimming, and the caller moves the camera on (to the parent region or the world).
 *  `padding` keeps the framing clear of panels floating over the map.
 *  The hold is soft: zooming out stops at the framing, and keeping on past it (`overshoot` counts
 *  up from 0 to 1 meanwhile) calls `onRelease`, for the caller to go up a level without a flight. */
export function useRegionCamera(
  map: MapLibreMap | null,
  {
    tiltAt,
    padding = FIT_PADDING,
    onRelease,
  }: { tiltAt: (zoom: number) => boolean; padding?: number | PaddingOptions; onRelease?: () => void },
) {
  // Keyed by map: a new map (theme change) starts in the world view.
  const [shown, setShown] = useState<{ map: MapLibreMap; framing: Framing } | null>(null);
  const framing = shown && shown.map === map ? shown.framing : null;
  const framingRef = useRef<Framing | null>(null);
  // The zoom the framing lands at, for telling a zoomed-in view from the framed one.
  const framedZoomRef = useRef<number | null>(null);
  const opts = useLatest({ tiltAt, padding, onRelease });
  const [overshoot, setOvershoot] = useState(0);
  const overshootRef = useRef(NO_OVERSHOOT);

  const fly = useCallback(
    (f: Framing, still = false) => {
      if (!map) return;
      const [w, s, e, n] = f.bounds;
      const camera = map.cameraForBounds(
        [
          [w, s],
          [e, n],
        ],
        // Past the archive's detail a small island would only blur.
        { padding: opts.current.padding, bearing: 0, maxZoom: 9 },
      );
      if (!camera) return;
      const move = { ...camera, ...regionCamera(f, opts.current.tiltAt(camera.zoom ?? 0), reducedMotion()) };
      framedZoomRef.current = camera.zoom ?? null;
      const hold = () => {
        if (framingRef.current !== f) return;
        map.setMinZoom(zoomFloor(camera.zoom ?? 0));
        // Room for the view at the zoom floor (half a level out), so the pan limit never stops
        // a zoom-out before the floor does.
        const v = map.getBounds();
        const [cx, cy] = [(v.getWest() + v.getEast()) / 2, (v.getSouth() + v.getNorth()) / 2];
        const [hw, hh] = [((v.getEast() - v.getWest()) / 2) * 1.5, ((v.getNorth() - v.getSouth()) / 2) * 1.5];
        const [pw, ps, pe, pn] = panLimits(f.bounds, [cx - hw, cy - hh, cx + hw, cy + hh]);
        // A wide window can show the whole world around a big region; there's nothing to hold then,
        // and MapLibre can't bound a box wider than the world.
        if (pe - pw >= 360) return;
        map.setMaxBounds([
          [pw, ps],
          [pe, pn],
        ]);
      };
      // The limits wait for the landing: the world view sits outside them.
      map.setMaxBounds(null);
      map.setMinZoom(null);
      // Let go of a smaller region mid-gesture: the camera stays where the user's zoom has it.
      if (still) return hold();
      if (move.duration === 0) {
        map.jumpTo(move);
        hold();
      } else {
        map.once("moveend", hold);
        map.flyTo({ ...move, easing: easeOut });
      }
    },
    [map, opts],
  );

  const enter = useCallback(
    (outline: unknown, code?: string | null, part?: number | null, { still = false } = {}) => {
      const whole = map && regionFraming(outline, code);
      const f = whole && part != null && whole.parts[part] ? partFraming(whole.parts[part]) : whole;
      if (!map || !f) return;
      framingRef.current = f;
      setShown({ map, framing: f });
      setTerrainExaggeration(map, f.exaggeration);
      showRegionOutline(map, outline);
      fly(f, still);
    },
    [map, fly],
  );

  const reset = useCallback(() => {
    overshootRef.current = NO_OVERSHOOT;
    setOvershoot(0);
    if (framingRef.current) fly(framingRef.current);
  }, [fly]);

  // The soft hold: zoom-out asked for at the floor (wheel, trackpad pinch, touch pinch, "-") builds
  // up; zooming in or panning starts over, as does a pause.
  useEffect(() => {
    if (!map || !framing) return;
    const container = map.getCanvasContainer();
    let pause: ReturnType<typeof setTimeout> | undefined;
    let fingers: number | null = null;
    const atFloor = () => map.getZoom() <= map.getMinZoom() + 0.05;
    const feed = (input: OvershootInput) => {
      const r = overshootStep(overshootRef.current, input);
      overshootRef.current = r.state;
      setOvershoot(r.status === "released" ? 0 : r.progress);
      clearTimeout(pause);
      if (r.status === "released") return opts.current.onRelease?.();
      pause = setTimeout(() => {
        overshootRef.current = NO_OVERSHOOT;
        setOvershoot(0);
      }, OVERSHOOT.resetMs);
    };
    const now = () => performance.now();
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) feed({ kind: "reset", at: now() });
      else if (atFloor()) feed({ kind: "out", levels: wheelLevels(e.deltaY, e.ctrlKey), at: now() });
    };
    const spread = (e: TouchEvent) =>
      e.touches.length === 2
        ? Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
        : null;
    const onTouchMove = (e: TouchEvent) => {
      const d = spread(e);
      if (d !== null && fingers !== null) {
        if (d > fingers) feed({ kind: "reset", at: now() });
        else if (atFloor()) feed({ kind: "out", levels: pinchLevels(fingers, d), at: now() });
      }
      fingers = d;
    };
    const onTouchEnd = () => (fingers = null);
    const onKey = (e: KeyboardEvent) => {
      if (matches(e, "regionOut")) {
        if (atFloor()) feed({ kind: "out", levels: KEY_LEVELS, at: now() });
      } else if (matches(e, "regionReset")) feed({ kind: "reset", at: now() });
    };
    const onPan = () => feed({ kind: "reset", at: now() });
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    container.addEventListener("touchend", onTouchEnd);
    container.addEventListener("keydown", onKey);
    map.on("dragstart", onPan);
    return () => {
      clearTimeout(pause);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("keydown", onKey);
      map.off("dragstart", onPan);
      overshootRef.current = NO_OVERSHOOT;
      setOvershoot(0);
    };
  }, [map, framing, opts]);

  const leave = useCallback(() => {
    framingRef.current = null;
    setShown(null);
    if (!map) return;
    map.setMaxBounds(null);
    map.setMinZoom(null);
    hideRegionOutline(map);
  }, [map]);

  useEffect(() => {
    framingRef.current = null;
  }, [map]);

  useKeyboardShortcuts(
    {
      zoomFit: (e) => {
        // The Lightbox or a dialog over the map owns the key.
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        reset();
      },
    },
    { enabled: !!framing },
  );

  const framedZoom = useCallback(() => (framingRef.current ? framedZoomRef.current : null), []);

  return { framing, enter, leave, reset, framedZoom, overshoot };
}
