import { useEffect } from "react";

/** Calls `onConfirm` when Enter is pressed anywhere while this is mounted and `enabled`, the
 * keyboard equivalent of clicking a dialog's one main/primary action, for dialogs that have no
 * `<form onSubmit>` of their own to get this for free (a plain text input inside a form already
 * submits on Enter natively; this is for everything else: a drag-to-crop editor, a picker with
 * no single text field, etc). Listens at the document level since there's no shared Modal
 * wrapper every dialog in this app already goes through to hook this into instead.
 *
 * Skipped, so it never fights something more specific: a textarea (Enter must stay a newline),
 * a contentEditable, a button/link/select (their own native Enter behavior already does the
 * right thing for whichever one is actually focused), still-composing IME input, or a keypress
 * some inner handler already called preventDefault on (e.g. an inline rename field's own
 * Enter-to-save). */
export function useEnterToConfirm(onConfirm: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter" || e.isComposing || e.defaultPrevented) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
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
