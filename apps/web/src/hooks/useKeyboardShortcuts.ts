import { useEffect } from "react";
import { useLatest } from "./useLatest";
import { isMac } from "../lib/platform";

/** Normalizes a KeyboardEvent into one of the map keys below: "escape", "delete", "mod+a", "s",
 *  "1".."5", etc. "mod" is Cmd on Mac, Ctrl everywhere else. */
function normalizeKey(e: KeyboardEvent): string {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  if (key === "escape") return "escape";
  if (key === "delete" || key === "backspace") return "delete";
  if (mod && key === "a") return "mod+a";
  return key;
}

/** Ignores keystrokes while focus is inside a text-editing control, which use plain typing and
 *  Enter for their own purpose. */
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
  // Read from a ref so a fresh object literal each render doesn't re-add the listener.
  const mapRef = useLatest(map);

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
  }, [enabled, mapRef]);
}
