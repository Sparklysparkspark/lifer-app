import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { isDragBlocked, subscribeDragBlocked } from "../lib/modalDragBlock";

// Renders nothing — tags the current page's own header as the drag region, rather than a
// floating overlay strip (which would sit above scrolled-up page content and swallow clicks
// meant for it). Tauri's isDragRegion() already lets a real <a>/<button> descendant take
// precedence over its drag-region ancestor, so this coexists with the header's own links. One
// tradeoff: dragging stops working once a page scrolls far enough that its header scrolls out
// of view (headers aren't position:sticky) — still better than an overlay that eats clicks.
const FADE_RANGE_PX = 20; // px of continuous ramp before the tint fully fades, vs. a hard cutoff
const OVERLAY_HEIGHT_PX = 56; // matches index.css's [data-mac-app] header.page-header clearance

export default function TitleBarDragRegion() {
  const location = useLocation();
  // A modal whose own controls sit in this band (Lightbox's close/info buttons, notably) opts
  // out via markDragBlocked — see modalDragBlock.ts's own comment for why this can't just be a
  // z-index fight.
  const dragBlocked = useSyncExternalStore(subscribeDragBlocked, isDragBlocked);
  // Measured live on every scroll tick rather than cached once, since a header's rendered
  // height can change after mount (e.g. a filter dropdown opening). Opacity ramps to 0 as the
  // header's bottom edge approaches the overlay's own bottom edge — past that point the
  // header's background no longer fills the overlay's band, so tinting further would tint real
  // page content instead.
  const [opacity, setOpacity] = useState(0);

  useEffect(() => {
    function recompute() {
      const header = document.querySelector<HTMLElement>("header.page-header");
      if (!header) {
        setOpacity(0);
        return;
      }
      const rect = header.getBoundingClientRect();
      // Nothing has scrolled yet (header's own top-padding is already doing its job) — no tint
      // needed regardless of how tall the header is.
      if (rect.top >= 0) {
        setOpacity(0);
        return;
      }
      const distancePastCutoff = rect.bottom - OVERLAY_HEIGHT_PX;
      setOpacity(Math.max(0, Math.min(1, distancePastCutoff / FADE_RANGE_PX)));
    }
    window.addEventListener("scroll", recompute, { passive: true });
    window.addEventListener("resize", recompute);
    recompute();
    return () => {
      window.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
    };
  }, [location.pathname]);

  useEffect(() => {
    // No platform gate — data-tauri-drag-region has no meaning outside Tauri's webview, so
    // tagging it unconditionally is harmless in a browser tab or the Docker/server deployment.
    const header = document.querySelector<HTMLElement>("header.page-header");
    if (!header) return;
    header.setAttribute("data-tauri-drag-region", "");
    return () => header.removeAttribute("data-tauri-drag-region");
  }, [location.pathname]);

  // Fixed full-width strip clearing the native traffic lights — that space is kept genuinely
  // empty of real content by design, so overlaying it never risks swallowing a click. macOS
  // only (Windows/Linux keep Tauri's normal decorated window, a real title bar outside the
  // webview). Also doubles as a fade mask: since headers aren't sticky, a long page's later
  // content scrolls up into this same band, and the gradient makes that read as "scrolled
  // away" instead of "stuck under the buttons."
  if (window.liferSetup?.platform !== "darwin") return null;
  return (
    <div
      data-tauri-drag-region=""
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: OVERLAY_HEIGHT_PX,
        zIndex: 2147483647,
        pointerEvents: dragBlocked ? "none" : "auto",
        // A fixed background (never toggled between two different CSS values) with an animated
        // opacity is what actually fades smoothly — browsers can't interpolate between two
        // different `background` strings (e.g. a gradient and "transparent"), which is exactly
        // why an earlier version of this snapped instantly between states instead of fading.
        background: "linear-gradient(to bottom, var(--color-surface) 0%, var(--color-surface) 60%, transparent 100%)",
        opacity,
        transition: "opacity 120ms ease-out",
      }}
    />
  );
}
