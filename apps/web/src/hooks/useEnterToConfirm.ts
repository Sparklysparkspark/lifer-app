import { useEffect } from "react";
import { matches } from "../lib/keymap";

/** Calls `onConfirm` on Enter while mounted and `enabled`, for dialogs without a `<form onSubmit>`.
 * Skipped for textareas, contentEditable, focused buttons/links/selects, IME composition, and
 * keypresses an inner handler already called preventDefault on. */
export function useEnterToConfirm(onConfirm: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (!matches(e, "confirm") || e.isComposing || e.defaultPrevented) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "BUTTON" || tag === "A" || tag === "SELECT") return;
      if ((e.target as HTMLElement | null)?.isContentEditable) return;
      e.preventDefault();
      onConfirm();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onConfirm, enabled]);
}
