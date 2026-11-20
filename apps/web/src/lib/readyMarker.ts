import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/** Sets `data-ready` on the document root to the current path once `isReady` and the first
 *  screen has drawn, so tests can time click to ready. Cleared when the page leaves. */
export function useReadyMarker(isReady: boolean): void {
  const { pathname } = useLocation();
  useEffect(() => {
    if (!isReady) return;
    const root = document.documentElement;
    // The frame after commit, when the content is on screen.
    const frame = requestAnimationFrame(() => root.setAttribute("data-ready", pathname));
    return () => {
      cancelAnimationFrame(frame);
      if (root.getAttribute("data-ready") === pathname) root.removeAttribute("data-ready");
    };
  }, [isReady, pathname]);
}
