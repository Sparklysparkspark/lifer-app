import { useEffect, useRef } from "react";

// Every open overlay, oldest first. Only the newest one closes on Escape, so a confirm dialog
// opened over a menu (or over another dialog) backs out one level per press.
const stack: Array<{ current: () => void }> = [];

function handleKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  // Marks it handled so window-level listeners (Lightbox, useKeyboardShortcuts) skip it.
  e.preventDefault();
  top.current();
}

/** Calls `onClose` on Escape while `enabled`, the keyboard twin of clicking a dialog's backdrop
 * or Cancel. Listens on document (bubble phase), so an inner field's own Escape handler that
 * calls preventDefault (e.g. closing an autocomplete) wins first. */
export function useEscapeToClose(onClose: () => void, enabled: boolean = true): void {
  const ref = useRef(onClose);
  ref.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    const entry = ref;
    stack.push(entry);
    if (stack.length === 1) document.addEventListener("keydown", handleKeyDown);
    return () => {
      const i = stack.lastIndexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) document.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled]);
}
