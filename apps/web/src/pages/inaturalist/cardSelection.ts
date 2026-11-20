import { useEffect, useMemo, useState } from "react";
import { useEscapeToClose } from "../../hooks/useEscapeToClose";
import { matches } from "../../lib/keymap";

// "count" (most first) only sorts species cards; a flat list keeps its newest-first order.
export type Sort = "newest" | "oldest" | "name" | "count";

/** Newest first is the API's order; the others are stable sorts of it. */
export function sortCards<T>(list: T[], sort: Sort, name: (item: T) => string): T[] {
  if (sort === "oldest") return [...list].reverse();
  if (sort === "name") return [...list].sort((a, b) => name(a).localeCompare(name(b)));
  return list;
}

/** Fired by a click on the page's empty background, to clear the selection like Finder does. */
export const CLEAR_SELECTION_EVENT = "inaturalist:clear-selection";

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/** Which cards are selected, with Shift-click ranges over the listed order. Only listed cards
 *  stay selected: a search or filter that hides one drops it, as the Gallery does. Esc,
 *  Mod+Shift+A and a click on the page background clear it, unless `paused` (a window is open). */
export function useCardSelection(visibleKeys: string[], paused = false) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  // Select mode, entered from the toolbar's Select (or a modified click): only then do cards show
  // their tick and a click toggles them, as in the Gallery.
  const [selecting, setSelecting] = useState(false);
  const visible = useMemo(() => new Set(visibleKeys), [visibleKeys]);
  // Adjusted while rendering, so a hidden card never shows as selected for a frame.
  if ([...selected].some((k) => !visible.has(k))) setSelected(new Set([...selected].filter((k) => visible.has(k))));

  const any = selected.size > 0;
  // On the shared Esc stack, so an open window or menu closes first. Esc clears the selection,
  // then a second one leaves select mode.
  useEscapeToClose(() => (any ? setSelected(new Set()) : setSelecting(false)), (any || selecting) && !paused);
  useEffect(() => {
    if (!any || paused) return;
    const clear = () => setSelected(new Set());
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (matches(e, "selectNone")) {
        e.preventDefault();
        clear();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(CLEAR_SELECTION_EVENT, clear);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(CLEAR_SELECTION_EVENT, clear);
    };
  }, [any, paused]);

  function toggle(key: string, range = false) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (range && anchor && visibleKeys.includes(anchor)) {
        const [a, b] = [visibleKeys.indexOf(anchor), visibleKeys.indexOf(key)].sort((x, y) => x - y);
        for (const k of visibleKeys.slice(a, b + 1)) next.add(k);
      } else if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setAnchor(key);
    setSelecting(true);
  }
  return {
    selected,
    // Selecting cards (Select all, Mod+A) also enters select mode.
    setSelected: (next: Set<string>) => {
      setSelected(next);
      if (next.size > 0) setSelecting(true);
    },
    toggle,
    clear: () => setSelected(new Set()),
    selecting,
    setSelecting: (on: boolean) => {
      setSelecting(on);
      if (!on) setSelected(new Set());
    },
  };
}
