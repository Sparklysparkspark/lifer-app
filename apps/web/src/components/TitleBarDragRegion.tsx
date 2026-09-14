import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { isDragBlocked, subscribeDragBlocked } from "../lib/modalDragBlock";

// Renders nothing — tags the current page's own header as the drag region, rather than a
// floating overlay strip (which would sit above scrolled-up page content and swallow clicks
// meant for it). Tauri's isDragRegion() already lets a real <a>/<button> descendant take
// precedence over its drag-region ancestor, so this coexists with the header's own links. One
// tradeoff: dragging stops working once a page scrolls far enough that its header scrolls out
// of view (headers aren't position:sticky) — still better than an overlay that eats clicks.
const OVERLAY_HEIGHT_PX = 56; // matches index.css's [data-mac-app] header.page-header clearance

export default function TitleBarDragRegion() {
  const location = useLocation();
  // A modal whose own controls sit in this band (Lightbox's close/info buttons, notably) opts
  // out via markDragBlocked — see modalDragBlock.ts's own comment for why this can't just be a
  // z-index fight.
  const dragBlocked = useSyncExternalStore(subscribeDragBlocked, isDragBlocked);
  // The overlay's HEIGHT (not opacity) tracks the header's own real bottom edge 1:1 — solid for
  // as long as any part of the header is still on screen, gone the instant it isn't. This used
  // to be an opacity ramp over a fixed-size box, tuned to approximate where the header's edge
  // probably was — fragile (a filter dropdown or a taller breadcrumb row could throw the timing
  // off) and it still needed a separate "hard cutoff vs. fade" judgment call. Sizing the box to
  // the real measured edge means the "disappear" moment IS the header leaving, not a guess at
  // when that happened — nothing to keep in sync, nothing to time.
  const [overlayHeight, setOverlayHeight] = useState(OVERLAY_HEIGHT_PX);

  useEffect(() => {
    function recompute() {
      const header = document.querySelector<HTMLElement>("header.page-header");
      if (!header) {
        setOverlayHeight(OVERLAY_HEIGHT_PX);
        return;
      }
      // Some pages (CollectionPage, notably) stack more white bg-surface strips directly under
      // the real <header> — a region breadcrumb row, then its own filter/sort/search toolbar —
      // that read as one continuous white header block even though they're not literally part
      // of header.page-header. The LAST such strip is marked with data-header-extension.
      // Queried anywhere in the document (not just as an adjacent sibling) since a breadcrumb
      // row can sit between the header and the marked strip. Without this, the overlay could
      // shrink away while that white block was still on screen underneath the traffic lights.
      const extension = document.querySelector<HTMLElement>("[data-header-extension]");
      const rect = extension ? extension.getBoundingClientRect() : header.getBoundingClientRect();
      setOverlayHeight(Math.max(0, Math.min(OVERLAY_HEIGHT_PX, rect.bottom)));
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
    // Deliberately NOT extended onto a page's own data-header-extension strip (see
    // recompute()'s comment on what that is) — that strip is packed with real inputs/selects/
    // checkboxes (CollectionPage's search box, Group/Sort/Taxon, sea-zone checkboxes), and
    // there's no way to verify from here whether Tauri's own isDragRegion() click-through
    // logic reliably excludes every one of those element types the way it does for a plain
    // <button>/<a> — not worth risking those controls becoming unclickable to fix a visual-only
    // fade. The extension only ever affects the fade calculation below, never draggability.
    const header = document.querySelector<HTMLElement>("header.page-header");
    if (!header) return;
    header.setAttribute("data-tauri-drag-region", "");
    return () => header.removeAttribute("data-tauri-drag-region");
  }, [location.pathname]);

  // Fixed full-width strip clearing the native traffic lights — that space is kept genuinely
  // empty of real content by design, so overlaying it never risks swallowing a click. macOS
  // only (Windows/Linux keep Tauri's normal decorated window, a real title bar outside the
  // webview). Unmounted entirely once the header has genuinely scrolled out of view (height
  // hits 0) — a real cutoff, not a faded-to-invisible element still sitting there.
  // Lightbox's own dim fullscreen backdrop sits above this overlay's z-index, but that overlay
  // is a solid white strip — even fully covered, it read as a stray white bar cut into the dim
  // view. markDragBlocked is only ever raised by Lightbox (see its own comment), so treating
  // "drag blocked" as "hide the strip entirely" is safe rather than just letting clicks pass
  // through it while it stayed visible underneath.
  if (window.liferSetup?.platform !== "darwin" || overlayHeight <= 0 || dragBlocked) return null;
  return (
    <div
      data-tauri-drag-region=""
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: overlayHeight,
        zIndex: 2147483647,
        pointerEvents: dragBlocked ? "none" : "auto",
        // Solid near the top (where the traffic lights actually sit) fading toward transparent
        // near this box's own bottom edge. That bottom edge only ever sits on top of the
        // header's own real background (overlayHeight is clamped to the header's true position),
        // so the fade always blends into more of the same white, never into unrelated content —
        // whatever's actually below the header only becomes visible once this box's height has
        // already shrunk past it, at which point there's no overlay there to fade at all.
        background: "linear-gradient(to bottom, var(--color-surface) 0%, var(--color-surface) 60%, transparent 100%)",
      }}
    />
  );
}
