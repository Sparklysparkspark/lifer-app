import { useRef, type KeyboardEvent, type ReactNode } from "react";
import Modal from "./Modal";
import Button from "./Button";

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  // null hides Cancel, for an OK-only notice.
  cancelLabel?: string | null;
  danger?: boolean;
  // Shows a spinner on the confirm button and blocks dismissal while the action runs.
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const SKIP_ENTER = new Set(["TEXTAREA", "BUTTON", "A", "SELECT"]);

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dismiss = () => {
    if (!busy) onCancel();
  };

  // Handled on the panel (not document) and marked handled, so an Enter-to-confirm on a dialog
  // underneath never fires for the same keypress.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.defaultPrevented || busy) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (SKIP_ENTER.has((e.target as HTMLElement).tagName)) return;
    e.preventDefault();
    onConfirm();
  }

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title={title}
      initialFocusRef={confirmRef}
      onKeyDown={onKeyDown}
      footer={
        <>
          {cancelLabel !== null && (
            <Button variant="secondary" size="sm" onClick={dismiss} disabled={busy}>
              {cancelLabel}
            </Button>
          )}
          <Button ref={confirmRef} variant={danger ? "danger" : "primary"} size="sm" onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message && <div className="text-sm text-muted">{message}</div>}
    </Modal>
  );
}
