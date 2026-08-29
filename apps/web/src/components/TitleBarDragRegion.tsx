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
    if (!document.documentElement.hasAttribute("data-mac-app")) return;
    const header = document.querySelector<HTMLElement>("header.page-header");
    if (!header) return;
    header.setAttribute("data-tauri-drag-region", "");
    return () => header.removeAttribute("data-tauri-drag-region");
  }, [location.pathname]);

  return null;
}
