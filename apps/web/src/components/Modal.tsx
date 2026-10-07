import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { markDragBlocked } from "../lib/modalDragBlock";

export type ModalSize = "sm" | "md" | "lg" | "xl";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  // Accessible name when there's no visible title.
  ariaLabel?: string;
  children?: ReactNode;
  // Right-aligned action row under the body.
  footer?: ReactNode;
  size?: ModalSize;
  dismissOnBackdrop?: boolean;
  // Focused on open instead of the first focusable element.
  initialFocusRef?: RefObject<HTMLElement | null>;
  // Keydown on the panel, e.g. ConfirmDialog's Enter-to-confirm.
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  className?: string;
}

const WIDTH: Record<ModalSize, string> = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-lg", xl: "max-w-2xl" };

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

// Counted so a modal opened over another keeps the page locked until the last one closes.
let scrollLocks = 0;
let savedOverflow = "";

function lockScroll() {
  if (scrollLocks++ === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
}

function unlockScroll() {
  if (--scrollLocks === 0) document.body.style.overflow = savedOverflow;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export default function Modal(props: ModalProps) {
  if (!props.open || typeof document === "undefined") return null;
  return createPortal(<ModalPanel {...props} />, document.body);
}

function ModalPanel({
  onClose,
  title,
  ariaLabel,
  children,
  footer,
  size = "sm",
  dismissOnBackdrop = true,
  initialFocusRef,
  onKeyDown,
  className = "",
}: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // Only a press that started on the backdrop closes it, so a text selection dragged out of the
  // panel doesn't dismiss the dialog.
  const pressStartedOnBackdrop = useRef(false);

  useEscapeToClose(onClose, true);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    lockScroll();
    // The macOS title strip sits above everything and would draw over the dim backdrop.
    markDragBlocked(true);

    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const target = initialFocusRef?.current ?? focusables(panel)[0] ?? panel;
      target.focus({ preventScroll: true });
    }

    // Native listener on the panel: nested modals portal to body as siblings, so each traps its own Tab.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || !panel) return;
      const items = focusables(panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
    panel?.addEventListener("keydown", onKeyDown);

    return () => {
      panel?.removeEventListener("keydown", onKeyDown);
      markDragBlocked(false);
      unlockScroll();
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
    // Mount-only: re-running would steal focus back on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        pressStartedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (dismissOnBackdrop && pressStartedOnBackdrop.current && e.target === e.currentTarget) onClose();
        pressStartedOnBackdrop.current = false;
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`max-h-[calc(100vh-2rem)] w-full ${WIDTH[size]} overflow-y-auto rounded-xl border border-line bg-surface p-5 text-ink shadow-lg outline-none ${className}`}
      >
        {title && (
          <h2 id={titleId} className="text-sm font-semibold text-ink">
            {title}
          </h2>
        )}
        {children != null && <div className={title ? "mt-2" : undefined}>{children}</div>}
        {footer && <div className="mt-4 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
