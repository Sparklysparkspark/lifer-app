import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

// Where a long, progressively revealed list was scrolled to, and how many of its cards were
// showing, kept per history entry so Back returns to the same spot. The browser's own restoration
// can't: it scrolls before the list has loaded and revealed enough cards, so the page is still
// too short and the position clamps.
interface SavedScroll {
  y: number;
  visible: number;
  /** The [data-scroll-anchor] element at the top of the screen, and how far below the top it was:
   *  content above it (a map, a banner) can load at a different height after Back. */
  anchor?: { id: string; top: number };
}

// How long after restoring to keep the anchor in place while the page above it settles.
const SETTLE_MS = 1500;
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "keydown", "mousedown"] as const;

function topAnchor(): SavedScroll["anchor"] {
  for (const el of document.querySelectorAll<HTMLElement>("[data-scroll-anchor]")) {
    const top = el.getBoundingClientRect().top;
    if (top >= 0) return { id: el.dataset.scrollAnchor!, top };
  }
  return undefined;
}

function scrollToAnchor(anchor: NonNullable<SavedScroll["anchor"]>): boolean {
  const el = document.querySelector<HTMLElement>(`[data-scroll-anchor="${CSS.escape(anchor.id)}"]`);
  if (!el) return false;
  window.scrollBy(0, el.getBoundingClientRect().top - anchor.top);
  return true;
}

const storageKey = (historyKey: string) => `lifer:scroll:${historyKey}`;

function read(historyKey: string): SavedScroll | null {
  try {
    const raw = sessionStorage.getItem(storageKey(historyKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedScroll>;
    return typeof parsed.y === "number" && typeof parsed.visible === "number"
      ? { y: parsed.y, visible: parsed.visible, anchor: parsed.anchor }
      : null;
  } catch {
    return null;
  }
}

function write(historyKey: string, value: SavedScroll): void {
  try {
    sessionStorage.setItem(storageKey(historyKey), JSON.stringify(value));
  } catch {
    // Storage can be full or blocked; Back then starts at the top, as before.
  }
}

/** Remembers the window's scroll position and the list's revealed card count for this history
 *  entry, and restores both on Back/Forward once `ready` (the list has rendered). Pass the returned
 *  values to the list: `initialVisibleCount` reveals as many cards as before so the old position
 *  exists, and `onVisibleCountChange` keeps the saved count current. */
export function useScrollMemory(ready: boolean): {
  initialVisibleCount: number | undefined;
  onVisibleCountChange: (count: number) => void;
} {
  const { key } = useLocation();
  const navigationType = useNavigationType();
  // Read once per history entry: only a Back/Forward (POP) returns to a saved spot.
  const [saved] = useState(() => (navigationType === "POP" ? read(key) : null));
  const visibleRef = useRef(saved?.visible ?? 0);
  const restored = useRef(false);

  const onVisibleCountChange = useCallback((count: number) => {
    visibleRef.current = count;
  }, []);

  useEffect(() => {
    let frame = 0;
    // Read as the user scrolls, not when leaving: the address changes a moment before this page
    // unmounts, and in between it re-renders for the new address and the scroll jumps. Only
    // positions taken while the history entry is still this one are kept.
    let y = window.scrollY;
    let anchor = topAnchor();
    const save = () => write(key, { y, visible: visibleRef.current, anchor });
    const onScroll = () => {
      // React Router calls the first page of a visit "default"; that entry has no key of its own.
      if (((window.history.state as { key?: string } | null)?.key ?? "default") !== key) return;
      y = window.scrollY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        anchor = topAnchor();
        save();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
      save();
    };
  }, [key]);

  useEffect(() => {
    if (!ready || !saved || restored.current) return;
    restored.current = true;
    const restore = () => {
      if (!saved.anchor || !scrollToAnchor(saved.anchor)) window.scrollTo(0, saved.y);
    };
    // Two frames: the revealed cards lay out (and fit their names) before the scroll is applied.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(restore);
    });
    // Then hold that card in place as the page above it finishes loading, until the user scrolls.
    const resize = new ResizeObserver(() => restore());
    resize.observe(document.body);
    const stop = () => {
      resize.disconnect();
      clearTimeout(timer);
      for (const type of USER_SCROLL_EVENTS) window.removeEventListener(type, stop);
    };
    const timer = setTimeout(stop, SETTLE_MS);
    for (const type of USER_SCROLL_EVENTS) window.addEventListener(type, stop, { passive: true });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      stop();
    };
  }, [ready, saved]);

  return { initialVisibleCount: saved?.visible || undefined, onVisibleCountChange };
}
