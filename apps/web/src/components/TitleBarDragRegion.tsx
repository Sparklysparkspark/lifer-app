import { useEffect } from "react";
import { useLocation } from "react-router-dom";

// Renders nothing — this just tags the CURRENT page's own header as the drag region, rather
// than drawing a separate floating strip over it. That first attempt (a `position: fixed`
// div pinned to the viewport's top 56px, ported over from Electron's -webkit-app-region
// approach) had a real bug: it sits above whatever's on screen at all times, including page
// content that scrolls UP into that band once you scroll down — so a link/button there would
// get its click silently swallowed by the strip instead (right-click "Open Link" still worked,
// since context-menu navigation doesn't go through the same click-completion path). Tagging
// the header element itself is what every other Tauri app does for this: drag.js's own
// isDragRegion() already special-cases a genuinely clickable descendant (a real <a>/<button>)
// as taking precedence over its drag-region ancestor, so this coexists correctly with the
// header's own back-link/nav — no click-blocking, because there's no separate overlay sitting
// on top of anything anymore. Only real gap versus the old approach: once you scroll a page far
// enough that its header scrolls out of view, dragging stops working until you scroll back up
// (headers aren't position:sticky) — vastly preferable to silently eating clicks everywhere.
export default function TitleBarDragRegion() {
  const location = useLocation();

  useEffect(() => {
    // No platform gate here — data-tauri-drag-region is a plain data attribute with no
    // meaning at all outside Tauri's own webview, so tagging it unconditionally is harmless
    // in a browser tab or the Docker/server deployment, and removes one more thing (the
    // data-mac-app attribute actually having been set correctly) that had to go right for
    // dragging to work at all.
    const header = document.querySelector<HTMLElement>("header.page-header");
    if (!header) return;
    header.setAttribute("data-tauri-drag-region", "");
    return () => header.removeAttribute("data-tauri-drag-region");
  }, [location.pathname]);

  // Always-mounted fallback, independent of the header-tagging effect above (and of whatever
  // was preventing that from working reliably — never fully root-caused, since there's no
  // devtools access into a running release build to inspect it live): a fixed strip spanning
  // the FULL WIDTH of the window, matching index.css's own [data-mac-app] header.page-header
  // clearance height (56px) — that space is kept genuinely empty of real content by design
  // (it exists purely to clear the native traffic lights), so overlaying it full-width here
  // never risks swallowing a click meant for a real header button/link sitting below it.
  // Only on macOS — Windows/Linux keep Tauri's normal decorated window (a real OS title bar
  // outside the webview entirely), so this would just be a dead click-zone over real page
  // content there for no benefit.
  if (window.liferSetup?.platform !== "darwin") return null;
  return (
    <div data-tauri-drag-region="" style={{ position: "fixed", top: 0, left: 0, right: 0, height: 56, zIndex: 2147483647 }} />
  );
}
