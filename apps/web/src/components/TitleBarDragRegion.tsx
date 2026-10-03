import { useEffect, useState, useSyncExternalStore } from "react";
import { isDragBlocked, subscribeDragBlocked } from "../lib/modalDragBlock";

// Makes the AppNav header a window drag region, plus a thin strip over the mac traffic lights.
// Tauri lets links and buttons inside a drag region keep their clicks.
const OVERLAY_HEIGHT_PX = 56; // matches index.css's [data-mac-app] header.page-header clearance

export default function TitleBarDragRegion() {
  // Lightbox raises this so its close/info buttons in this band stay clickable.
  const dragBlocked = useSyncExternalStore(subscribeDragBlocked, isDragBlocked);
  // The strip's height follows the header's real bottom edge, so it vanishes as the header
  // scrolls away instead of covering page content.
  const [overlayHeight, setOverlayHeight] = useState(OVERLAY_HEIGHT_PX);
  // Pages without the header (sign-in, setup) get a solid strip in the page's own color, since the
  // fade only makes sense over the header.
  const [hasHeader, setHasHeader] = useState(false);

  useEffect(() => {
    let frame = 0;
    function sync() {
      frame = 0;
      const header = document.querySelector<HTMLElement>("header.page-header");
      setHasHeader(!!header);
      if (!header) {
        setOverlayHeight(OVERLAY_HEIGHT_PX);
        return;
      }
      // Only the header itself drags. Not the data-header-extension strip, which is full of inputs.
      if (!header.hasAttribute("data-tauri-drag-region")) header.setAttribute("data-tauri-drag-region", "");
      // Collection's toolbar reads as part of the header, so it marks the header's visual bottom.
      const extension = document.querySelector<HTMLElement>("[data-header-extension]");
      const rect = (extension ?? header).getBoundingClientRect();
      setOverlayHeight(Math.max(0, Math.min(OVERLAY_HEIGHT_PX, rect.bottom)));
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(sync);
    }
    // AppNav mounts after auth loads and the toolbar after data loads, often with no route change.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
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
        // The fade only ever lands on the header's own background, since the height is clamped to it.
        background: hasHeader
          ? "linear-gradient(to bottom, var(--color-surface) 0%, var(--color-surface) 60%, transparent 100%)"
          : "var(--color-canvas)",
      }}
    />
  );
}
