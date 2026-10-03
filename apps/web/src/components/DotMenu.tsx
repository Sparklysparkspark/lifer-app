import {
  cloneElement,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

// The shared "⋯" trigger and panel shell for card and tile actions. The caller owns the open
// state (usually useDropdownMenu, so one menu is open at a time) and the panel content.
export default function DotMenu({
  open,
  onToggle,
  menuRef,
  children,
  className,
  anchorPoint,
}: {
  open: boolean;
  onToggle: () => void;
  /** Attached only while open, matching useDropdownMenu's contract. */
  menuRef?: RefObject<HTMLDivElement | null>;
  /** The panel element, with its own width and positioning classes (they vary per caller). */
  children: ReactNode;
  /** Positions the trigger; defaults to the top-right corner. */
  className?: string;
  /** Right-click mode: no trigger; the panel is portaled to body at this viewport point and
   *  clamped to the window edges. */
  anchorPoint?: { x: number; y: number } | null;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [fixedPosition, setFixedPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchorPoint || !open) return;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let top = anchorPoint.y;
    let left = anchorPoint.x;
    if (top + rect.height > window.innerHeight - margin) top = window.innerHeight - rect.height - margin;
    if (left + rect.width > window.innerWidth - margin) left = window.innerWidth - rect.width - margin;
    top = Math.max(margin, top);
    left = Math.max(margin, left);
    setFixedPosition({ top, left });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, anchorPoint?.x, anchorPoint?.y]);

  // A panel that would overflow the viewport switches to position: fixed at clamped coordinates.
  // Re-measures after every commit (content can grow without `open` changing), with a ResizeObserver backstop.
  useLayoutEffect(() => {
    if (anchorPoint) return;
    if (!open) {
      setFixedPosition((prev) => (prev === null ? prev : null));
      return;
    }
    const el = panelRef.current;
    if (!el) return;

    const reposition = () => {
      const rect = el.getBoundingClientRect();
      const margin = 8;
      // One clamp per axis, so a panel taller than the window settles at the margin instead of
      // oscillating between "fix bottom" and "fix top".
      const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
      const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      const top = Math.min(Math.max(rect.top, margin), maxTop);
      const left = Math.min(Math.max(rect.left, margin), maxLeft);
      const needsFix = Math.abs(top - rect.top) > 0.5 || Math.abs(left - rect.left) > 0.5;
      setFixedPosition((prev) => {
        if (!needsFix) return prev === null ? prev : null;
        if (prev && Math.abs(prev.top - top) < 0.5 && Math.abs(prev.left - left) < 0.5) return prev;
        return { top, left };
      });
    };

    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(el);
    return () => observer.disconnect();
  });

  const panel =
    open &&
    isValidElement(children) &&
    cloneElement(children as ReactElement<{ ref?: RefObject<HTMLDivElement | null>; style?: CSSProperties }>, {
      ref: panelRef,
      style: fixedPosition
        ? {
            position: "fixed",
            top: fixedPosition.top,
            left: fixedPosition.left,
            right: "auto",
            // Caps the size in case it grows after the measurement.
            maxWidth: "calc(100vw - 16px)",
            maxHeight: "calc(100vh - 16px)",
          }
        : anchorPoint
          ? // First paint, before measuring: hidden at the click point so it never flashes at (0,0).
            { position: "fixed", top: anchorPoint.y, left: anchorPoint.x, right: "auto", visibility: "hidden" }
          : undefined,
    });

  if (anchorPoint) {
    // Portaled so overflow-hidden tiles don't clip it.
    return open ? createPortal(<div ref={menuRef}>{panel}</div>, document.body) : null;
  }

  return (
    <div className={className ?? "absolute right-1 top-1"} ref={open ? menuRef : undefined}>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }}
        aria-label="More options"
        className={`rounded-full bg-black/40 px-1.5 py-0.5 text-xs text-white hover:bg-black/60 ${
          open ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        ⋯
      </button>
      {/* cloneElement, not a wrapper div: a wrapper around an absolute panel collapses to 0x0
         and the measurements would read it instead of the panel. */}
      {panel}
    </div>
  );
}
