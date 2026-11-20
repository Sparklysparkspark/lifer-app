import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { matches } from "../lib/keymap";
import { useLatest } from "../hooks/useLatest";
import {
  clampView,
  containFit,
  FIT,
  FULL,
  pinchFactor,
  wheelPixels,
  zoomView,
  type Fit,
  type View,
} from "../lib/compareZoom";

const transformOf = (v: View) => `translate3d(${v.x * 100}%, ${v.y * 100}%, 0) scale(${v.scale})`;
// Past this a press is a drag, not a click.
const DRAG_PX = 3;
// A click waits this long for a second one, so a double-click zooms instead of opening.
const DOUBLE_CLICK_MS = 250;

type Gesture = Event & { scale: number; clientX: number; clientY: number };

// The one zoomable photo frame (Lightbox, both compare views): trackpad pinch (ctrl+wheel, or
// WebKit's gesture events), wheel to pan once zoomed, double-click, and drag. Gestures build on the
// view being drawn, not the last render's, and are drawn once per frame as a transform on a GPU
// layer, with no transition, so a fast pinch never stutters or steps back. The view also goes to
// the caller once per frame, so several frames can share one (Link zoom).
export default function ZoomPane({
  view,
  onViewChange,
  onMouseDown,
  onBackdropClick,
  onOpen,
  openLabel,
  className = "",
  children,
}: {
  view: View;
  onViewChange: (view: View) => void;
  onMouseDown?: () => void;
  /** A click beside the photo (the Lightbox closes). Clicks on the photo stop here. */
  onBackdropClick?: () => void;
  /** A plain click on the photo, or F or Enter with the frame focused: open it larger (the Lightbox).
   *  A drag still pans and a double-click still zooms. */
  onOpen?: () => void;
  /** The focusable frame's name when `onOpen` is set. */
  openLabel?: string;
  className?: string;
  /** The photo, drawn h-full w-full object-contain. */
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const live = useRef(view);
  const emitted = useRef(view);
  const raf = useRef(0);
  const fit = useRef<Fit>(FULL);
  const drag = useRef<{ x: number; y: number; view: View; w: number; h: number } | null>(null);
  const dragged = useRef(false);
  // Where the last press began: moving past DRAG_PX makes it a drag, zoomed in or not.
  const pressAt = useRef<{ x: number; y: number } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onChange = useLatest(onViewChange);
  const onOpenRef = useLatest(onOpen);

  const draw = (v: View) => {
    if (layerRef.current) layerRef.current.style.transform = transformOf(v);
  };
  const schedule = (next: View) => {
    live.current = next;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      draw(live.current);
      emitted.current = live.current;
      onChange.current(live.current);
    });
  };

  // A change from outside (Fit, keys, the linked frame) is drawn at once, inside this photo's edges.
  useLayoutEffect(() => {
    if (view === emitted.current) return;
    emitted.current = view;
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    live.current = clampView(view, fit.current);
    draw(live.current);
  }, [view]);

  // How much of the frame the photo covers, for the pan limits; again whenever either resizes.
  function measure() {
    const img = layerRef.current?.querySelector("img");
    const frame = frameRef.current;
    if (!img?.naturalWidth || !frame?.offsetHeight) return;
    fit.current = containFit(img.naturalWidth / img.naturalHeight / (frame.offsetWidth / frame.offsetHeight));
    live.current = clampView(live.current, fit.current);
    draw(live.current);
  }
  const measureRef = useLatest(measure);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureRef.current());
    observer.observe(frame);
    return () => observer.disconnect();
  }, [measureRef]);
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      clearTimeout(openTimer.current);
    },
    [],
  );

  // Native, non-passive listeners: React's wheel listener can't stop the page from zooming.
  const scheduleRef = useLatest(schedule);
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const at = (x: number, y: number, box: DOMRect) => ({
      fx: (x - box.left) / box.width - 0.5,
      fy: (y - box.top) / box.height - 0.5,
    });
    let pinching: View | null = null;
    function onWheel(e: WheelEvent) {
      const v = live.current;
      const box = el!.getBoundingClientRect();
      const dy = wheelPixels(e.deltaY, e.deltaMode, box.height);
      if (e.ctrlKey) {
        e.preventDefault();
        // WebKit's own gesture events are already zooming.
        if (pinching) return;
        const { fx, fy } = at(e.clientX, e.clientY, box);
        scheduleRef.current(zoomView(v, v.scale * pinchFactor(dy), fx, fy, fit.current));
      } else if (v.scale > 1) {
        e.preventDefault();
        const dx = wheelPixels(e.deltaX, e.deltaMode, box.width);
        scheduleRef.current(clampView({ ...v, x: v.x - dx / box.width, y: v.y - dy / box.height }, fit.current));
      }
    }
    function onGestureStart(e: Event) {
      e.preventDefault();
      pinching = live.current;
    }
    function onGestureChange(e: Event) {
      e.preventDefault();
      if (!pinching) return;
      const g = e as Gesture;
      const { fx, fy } = at(g.clientX, g.clientY, el!.getBoundingClientRect());
      scheduleRef.current(zoomView(pinching, pinching.scale * g.scale, fx, fy, fit.current));
    }
    function onGestureEnd(e: Event) {
      e.preventDefault();
      pinching = null;
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, [scheduleRef]);

  const pointIn = (e: MouseEvent) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { fx: (e.clientX - box.left) / box.width - 0.5, fy: (e.clientY - box.top) / box.height - 0.5 };
  };
  function onDoubleClick(e: MouseEvent) {
    clearTimeout(openTimer.current);
    const { fx, fy } = pointIn(e);
    const v = live.current;
    schedule(v.scale > 1 ? FIT : zoomView(v, 2.5, fx, fy, fit.current));
  }
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    onMouseDown?.();
    dragged.current = false;
    pressAt.current = { x: e.clientX, y: e.clientY };
    if (e.button !== 0 || live.current.scale <= 1) return;
    // Captured, so a drag past the frame's edge keeps panning.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const box = e.currentTarget.getBoundingClientRect();
    drag.current = { x: e.clientX, y: e.clientY, view: live.current, w: box.width, h: box.height };
  }
  function onPointerMove(e: PointerEvent) {
    const p = pressAt.current;
    if (p && Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > DRAG_PX) dragged.current = true;
    const d = drag.current;
    if (!d) return;
    schedule(
      clampView(
        { ...d.view, x: d.view.x + (e.clientX - d.x) / d.w, y: d.view.y + (e.clientY - d.y) / d.h },
        fit.current,
      ),
    );
  }
  const endDrag = () => {
    drag.current = null;
    pressAt.current = null;
  };
  function onClick(e: MouseEvent) {
    e.stopPropagation();
    if (dragged.current) return;
    if (onOpen) {
      clearTimeout(openTimer.current);
      if (e.detail < 2) openTimer.current = setTimeout(() => onOpenRef.current?.(), DOUBLE_CLICK_MS);
      return;
    }
    if (!onBackdropClick) return;
    const { fx, fy } = pointIn(e);
    const v = live.current;
    const onPhoto =
      Math.abs(fx - v.x) <= (v.scale * fit.current.w) / 2 && Math.abs(fy - v.y) <= (v.scale * fit.current.h) / 2;
    if (!onPhoto) onBackdropClick();
  }

  return (
    <div
      ref={frameRef}
      data-zoom-pane
      className={`relative overflow-hidden focus-visible:-outline-offset-2 ${view.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"} ${className}`}
      onLoadCapture={measure}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={onClick}
      {...(onOpen && {
        tabIndex: 0,
        role: "button",
        "aria-label": openLabel,
        onKeyDown: (e: KeyboardEvent) => {
          if (!matches(e, "fullScreen") && !matches(e, "confirm")) return;
          // Before the viewer's own keys (Enter confirms there), which skip a handled event.
          e.preventDefault();
          onOpen();
        },
      })}
    >
      <div
        ref={layerRef}
        className="pointer-events-none h-full w-full select-none will-change-transform"
        style={{ transform: transformOf(view) }}
      >
        {children}
      </div>
    </div>
  );
}
