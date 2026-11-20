import {
  useEffect,
  useId,
  useRef,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { matches } from "../lib/keymap";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { markDragBlocked } from "../lib/modalDragBlock";
import { primaryButtonFirst } from "../lib/platform";

// sm: alerts and confirms. md: forms and pickers (the default). lg: maps, photo grids, long lists.
export type ModalSize = "sm" | "md" | "lg";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  // One plain line under the title.
  description?: ReactNode;
  // Accessible name when there's no visible title.
  ariaLabel?: string;
  children?: ReactNode;
  // Cancel then the one primary action; the footer orders them for the platform.
  footer?: ReactNode;
  // A tertiary action (Reset, Clear) pinned to the footer's start.
  footerStart?: ReactNode;
  // Makes the dialog a form, so a footer Button type="submit" and Enter in a field both submit.
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  size?: ModalSize;
  dismissOnBackdrop?: boolean;
  // Focused on open instead of the first focusable element.
  initialFocusRef?: RefObject<HTMLElement | null>;
  // Keydown on the panel, e.g. ConfirmDialog's Enter-to-confirm.
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}

// Below the sm breakpoint every size is a full-width sheet from the bottom.
const WIDTH: Record<ModalSize, string> = { sm: "sm:max-w-md", md: "sm:max-w-xl", lg: "sm:max-w-3xl" };
const ENTER_MS = 160;
const EXIT_MS = 120;

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

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;

// Fades an inert copy of the closed dialog, so every way of closing it (open={false} or unmounting) animates.
function fadeOut(overlay: HTMLElement) {
  if (typeof overlay.animate !== "function") return;
  const ghost = overlay.cloneNode(true) as HTMLElement;
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.pointerEvents = "none";
  // Not a dialog any more, and no duplicate ids for the next dialog's labels and form= links.
  for (const el of [ghost, ...ghost.querySelectorAll("[id], [role], [data-modal]")]) {
    el.removeAttribute("id");
    el.removeAttribute("role");
    el.removeAttribute("data-modal");
  }
  document.body.appendChild(ghost);
  const anim = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: EXIT_MS, easing: "ease-in" });
  anim.onfinish = anim.oncancel = () => ghost.remove();
}

export default function Modal(props: ModalProps) {
  if (!props.open || typeof document === "undefined") return null;
  return createPortal(<ModalPanel {...props} />, document.body);
}

function ModalPanel({
  onClose,
  title,
  description,
  ariaLabel,
  children,
  footer,
  footerStart,
  onSubmit,
  size = "md",
  dismissOnBackdrop = true,
  initialFocusRef,
  onKeyDown,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
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

    const overlay = overlayRef.current;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const target = initialFocusRef?.current ?? focusables(panel)[0] ?? panel;
      target.focus({ preventScroll: true });
    }
    overlay?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: ENTER_MS, easing: "ease-out" });
    if (!reducedMotion()) {
      panel?.animate?.([{ transform: "translateY(0.75rem) scale(0.98)" }, { transform: "none" }], {
        duration: ENTER_MS,
        easing: "cubic-bezier(0.2, 0.9, 0.3, 1)",
      });
    }

    // Native listener on the panel: nested modals portal to body as siblings, so each traps its own Tab.
    function onKeyDown(e: KeyboardEvent) {
      if (!matches(e, "focusCycle") || !panel) return;
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
      // Still attached means React is re-running effects (StrictMode), not closing.
      if (overlay && !overlay.isConnected) fadeOut(overlay);
      markDragBlocked(false);
      unlockScroll();
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: re-running would steal focus back on every parent render
  }, []);

  const hasFooter = !!footer || !!footerStart;
  const content = (
    <>
      {/* Only the body scrolls, so the title and the action buttons stay in view in a tall dialog. */}
      {title && (
        <div className="shrink-0 px-5 pt-5">
          <h2 id={titleId} className="text-title-3 font-semibold text-ink wrap-anywhere">
            {title}
          </h2>
          {description && (
            <p id={descriptionId} className="mt-1 text-callout text-muted wrap-anywhere">
              {description}
            </p>
          )}
        </div>
      )}
      {children != null && (
        <div
          className={`min-h-0 flex-1 overflow-y-auto px-5 ${title ? "pt-3" : "pt-5"} ${hasFooter ? "pb-1" : "pb-5"}`}
        >
          {children}
        </div>
      )}
      {hasFooter && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-4 pb-5">
          {!!footerStart && <div className="flex flex-wrap items-center gap-2">{footerStart}</div>}
          <div
            className={`ml-auto flex flex-wrap items-center gap-2 ${primaryButtonFirst() ? "flex-row-reverse" : ""}`}
          >
            {footer}
          </div>
        </div>
      )}
    </>
  );

  return (
    <div
      ref={overlayRef}
      // design-token: the scrim is black in both themes, like the system sheet backdrop
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
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
        data-modal
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={title && description ? descriptionId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          // Return fires the default button, but only from the panel itself: fields and buttons own their Enter.
          if (e.defaultPrevented || e.nativeEvent.isComposing || e.target !== e.currentTarget || !matches(e, "confirm"))
            return;
          const primary = e.currentTarget.querySelector<HTMLButtonElement>("button[data-primary]:not(:disabled)");
          if (!primary) return;
          e.preventDefault();
          primary.click();
        }}
        // design-token: the panel only takes focus as a fallback target, so it shows no ring
        className={`flex max-h-[calc(100dvh-2rem)] w-full ${WIDTH[size]} flex-col overflow-hidden rounded-t-panel border border-line bg-surface pb-[env(safe-area-inset-bottom)] text-ink shadow-lg outline-none sm:rounded-panel sm:pb-0`}
      >
        {onSubmit ? (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit(e);
            }}
          >
            {content}
          </form>
        ) : (
          content
        )}
      </div>
    </div>
  );
}
