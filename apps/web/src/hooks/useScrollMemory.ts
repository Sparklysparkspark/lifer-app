import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

// Where a long, progressively revealed list was scrolled to, and how many of its cards were
// showing, kept per history entry so Back returns to the same spot. The browser's own restoration
// can't: it scrolls before the list has loaded and revealed enough cards, so the page is still
// too short and the position clamps.
interface SavedScroll {
  y: number;
  visible: number;
}

const storageKey = (historyKey: string) => `lifer:scroll:${historyKey}`;

function read(historyKey: string): SavedScroll | null {
  try {
    const raw = sessionStorage.getItem(storageKey(historyKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedScroll>;
    return typeof parsed.y === "number" && typeof parsed.visible === "number"
      ? { y: parsed.y, visible: parsed.visible }
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
    const save = () => write(key, { y: window.scrollY, visible: visibleRef.current });
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
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
    // Two frames: the revealed cards lay out (and fit their names) before the scroll is applied.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => window.scrollTo(0, saved.y));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [ready, saved]);

  return { initialVisibleCount: saved?.visible || undefined, onVisibleCountChange };
}
