import { useEffect, useRef } from "react";

/** Normalizes a KeyboardEvent into one of the map keys below: "escape", "delete", "mod+a", "s",
 *  "1".."5", etc. "mod" is Cmd on Mac, Ctrl everywhere else — the same convention every desktop
 *  app already uses, checked once via navigator.platform rather than per-keystroke. */
function normalizeKey(e: KeyboardEvent): string {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  if (key === "escape") return "escape";
  if (key === "delete" || key === "backspace") return "delete";
  if (mod && key === "a") return "mod+a";
  return key;
}

/** Ignores keystrokes while focus is inside a text-editing control — EditableTextField and
 *  every inline-rename field already use plain Enter/typing for their own purpose, and a global
 *  shortcut hijacking those would be a real regression, not a convenience. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

/** One window-level keydown listener per mount, dispatching to whichever handler in `map`
 *  matches the normalized key. Pass `enabled: false` to fully disable a hook instance (e.g. a
 *  modal that wants exclusive key handling while it's open) without unmounting it. */
export function useKeyboardShortcuts(map: Record<string, (e: KeyboardEvent) => void>, opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  // The map is read from a ref (updated every render) rather than added straight to the effect's
  // deps — a caller typically passes a fresh object literal each render, which would otherwise
  // tear down and re-add the real DOM listener constantly instead of just once per mount.
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    if (!enabled) return;
    function handleKeyDown(e: KeyboardEvent) {
      // defaultPrevented: an open dialog/menu already handled this key (see useEscapeToClose).
      if (isTypingTarget(e.target) || e.defaultPrevented) return;
      const normalized = normalizeKey(e);
      const handler = mapRef.current[normalized];
      if (handler) handler(e);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled]);
}
