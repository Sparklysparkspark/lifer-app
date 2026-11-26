import { useEffect } from "react";
import { useLatest } from "./useLatest";
import { liveOnPluginPage, matches, type KeyAction } from "../lib/keymap";
import { pluginIdFromPath } from "../lib/plugins";

/** Ignores keystrokes while focus is inside a text-editing control, which use plain typing and
 *  Enter for their own purpose. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

/** One window-level keydown listener per mount, dispatching to whichever handler in `map`
 *  matches the normalized key. Pass `enabled: false` to fully disable a hook instance (e.g. a
 *  modal that wants exclusive key handling while it's open) without unmounting it. */
export function useKeyboardShortcuts(
  map: Partial<Record<KeyAction, (e: KeyboardEvent) => void>>,
  opts?: { enabled?: boolean },
) {
  const enabled = opts?.enabled ?? true;
  // Read from a ref so a fresh object literal each render doesn't re-add the listener.
  const mapRef = useLatest(map);

  useEffect(() => {
    if (!enabled) return;
    function handleKeyDown(e: KeyboardEvent) {
      // defaultPrevented: an open dialog/menu already handled this key (see useEscapeToClose).
      if (isTypingTarget(e.target) || e.defaultPrevented) return;
      const onAppPage = pluginIdFromPath(window.location.pathname) !== null;
      for (const [action, handler] of Object.entries(mapRef.current)) {
        if (onAppPage && !liveOnPluginPage(action as KeyAction)) continue;
        if (matches(e, action as KeyAction)) {
          handler?.(e);
          return;
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, mapRef]);
}
