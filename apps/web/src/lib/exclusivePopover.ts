// One toolbar popover or menu open at a time: opening one closes any other, even when its trigger
// stops the click from reaching the others' outside-click listeners.
import { useEffect, useId } from "react";
import { useLatest } from "../hooks/useLatest";

const EVENT = "lifer:popover-open";

/** Call with whether this popover is open and how to close it. */
export function useExclusiveOpen(open: boolean, close: () => void): void {
  const id = useId();
  const closeRef = useLatest(close);
  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) closeRef.current();
    };
    window.addEventListener(EVENT, onOther);
    return () => window.removeEventListener(EVENT, onOther);
  }, [open, id, closeRef]);
}
