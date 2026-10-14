import { useEffect, useState, useSyncExternalStore } from "react";
import { isDragBlocked, subscribeDragBlocked } from "../lib/modalDragBlock";
import { useTheme } from "../hooks/useTheme";
import { tauriInvoke } from "../lib/tauri";

// Makes the AppNav header a window drag region, plus a bar across the top of the mac window behind
// the traffic lights. The bar stays put as the page scrolls, so the window controls always have a
// background of their own instead of floating over photos. Tauri lets links and buttons inside a
// drag region keep their clicks.
const TITLE_BAR_PX = 40; // matches index.css's --mac-title-bar
// Pages without the header (sign-in, setup) get a solid strip as deep as the header's clearance.
const NO_HEADER_PX = 56; // matches index.css's [data-mac-app] header.page-header padding
// macOS greys the traffic lights out while the window is in the background, which on the white
// title bar leaves them nearly invisible. The desktop app gives each native button a round colour
// beneath its own drawing (window_controls.rs): its own colour while active, light grey in the
// background, none in dark mode where they stand out already. Native, so it never moves with the
// page's rubber-band bounce. `off` while the photo viewer's black backdrop is up. Re-sent when full
// screen ends, since leaving it can rebuild the buttons.
function useTrafficLightBackdrop(off: boolean, fullscreen: boolean) {
  const focused = useWindowFocused();
  const dark = useTheme().theme === "dark";
  const state = off || dark ? "off" : focused ? "active" : "inactive";
  useEffect(() => {
    const invoke = tauriInvoke();
    if (!invoke || window.liferSetup?.platform !== "darwin" || fullscreen) return;
    void invoke("set_traffic_light_backdrop", { state }).catch(() => {});
  }, [state, fullscreen]);
}

function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return focused;
}

export default function TitleBarDragRegion() {
  // Lightbox raises this so its close/info buttons in this band stay clickable.
  const dragBlocked = useSyncExternalStore(subscribeDragBlocked, isDragBlocked);
  // Over the header the bar blends in; once the header has scrolled up under it, page content is
  // behind the bar, which then shows a bottom edge.
  const [contentUnder, setContentUnder] = useState(false);
  const [hasHeader, setHasHeader] = useState(false);
  // Full screen hides the traffic lights and can't be dragged, so there's nothing to cover (main.tsx
  // sets data-fullscreen).
  const [fullscreen, setFullscreen] = useState(false);
  useTrafficLightBackdrop(dragBlocked, fullscreen);

  useEffect(() => {
    let frame = 0;
    function sync() {
      frame = 0;
      setFullscreen(document.documentElement.hasAttribute("data-fullscreen"));
      const header = document.querySelector<HTMLElement>("header.page-header");
      setHasHeader(!!header);
      if (!header) return;
      // Only the header itself drags. Not the data-header-extension strip, which is full of inputs.
      if (!header.hasAttribute("data-tauri-drag-region")) header.setAttribute("data-tauri-drag-region", "");
      // Collection's toolbar and a page's back-link bar read as part of the header, so they mark
      // its visual bottom.
      const extension = document.querySelector<HTMLElement>("[data-header-extension]");
      setContentUnder((extension ?? header).getBoundingClientRect().bottom < TITLE_BAR_PX);
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(sync);
    }
    // AppNav mounts after auth loads and the toolbar after data loads, often with no route change.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-fullscreen"] });
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    sync();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  // macOS only: Windows and Linux keep a native title bar. Hidden while a Lightbox is open so it
  // doesn't show as a white bar over the dim backdrop.
  if (window.liferSetup?.platform !== "darwin" || dragBlocked || fullscreen) return null;
  return (
    <div
      data-tauri-drag-region=""
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: hasHeader ? TITLE_BAR_PX : NO_HEADER_PX,
        zIndex: 2147483647,
        ...(hasHeader
          ? {
              background: "color-mix(in srgb, var(--color-surface) 80%, transparent)",
              backdropFilter: "blur(16px) saturate(180%)",
              WebkitBackdropFilter: "blur(16px) saturate(180%)",
              borderBottom: `1px solid ${contentUnder ? "var(--color-line)" : "transparent"}`,
            }
          : { background: "var(--color-canvas)" }),
      }}
    />
  );
}
