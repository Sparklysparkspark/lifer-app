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

// The one "⋯" menu trigger + dropdown panel shell, used everywhere a card/tile needs a small
// set of contextual actions without competing for space with the rest of its content —
// previously hand-rebuilt slightly differently in PhotoTile (a black "⋯" circle) and
// SpeciesCard (a white "⋮" circle with its own separate open/close logic), which is exactly
// how they drifted into two different looks. This owns only the trigger + panel shell; the
// caller still supplies its own open/toggle state (typically useDropdownMenu, so only one
// tile's menu is ever open at once across a grid) and the panel's content.
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
  /** Only meaningful (and only needs to be attached) while open is true — matches
   *  useDropdownMenu's own "ref only tracks the currently-open one" contract. */
  menuRef?: RefObject<HTMLDivElement | null>;
  /** The dropdown panel content, including its own width/positioning classes — panel shape
   *  genuinely varies per caller (a species card's panel opens upward from a bottom-corner
   *  trigger; a photo tile's opens downward from the top), so this doesn't impose one fixed
   *  shape on every caller. */
  children: ReactNode;
  /** Positions the trigger button itself — defaults to the top-right corner most photo tiles
   *  use. */
  className?: string;
  /** Right-click ("⋯"-free) mode: when set, no "⋯" trigger is rendered at all — the panel is
   *  portaled straight to document.body and pinned at this viewport point (the click location)
   *  instead of anchored to a button. Same edge-clamping as the normal button-anchored panel, so
   *  a right-click near the window edge doesn't render off-screen. */
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

  // Whatever positioning classes the caller's panel uses (opening downward from the trigger is
  // the common case), a tile near an edge of the viewport would push the panel past that edge —
  // forcing a scroll, or at the smallest gallery grid size, cutting the panel off the LEFT edge
  // entirely (a right-anchored panel extends leftward from a tiny tile's right edge, and at the
  // smallest thumbnail size a leftmost-column tile's right edge sits close enough to x=0 that the
  // whole panel lands off-screen). Measuring after paint and repositioning the panel keeps it
  // anchored to the trigger without needing every caller to hand-reason about its own position on
  // screen, and doing it for all four edges (not just the bottom) covers both cases.
  //
  // This used to just apply a CSS `transform: translateY(...)` to nudge the panel up — visually
  // correct, but a transform never changes the space an element reserves in the page's own
  // layout (its untransformed box is still what ancestors measure for scrollable overflow), so
  // the document kept growing a real scrollbar to fit a panel that only ever appeared to move.
  // Switching the overflowing panel to `position: fixed` (with its on-screen coordinates
  // captured before the switch) actually removes it from document flow, so it can never expand
  // page scroll no matter how close to an edge the trigger is.
  // Deliberately no dependency array — this must re-run after EVERY render while open, not just
  // when `open` itself changes. A panel whose content grows because of a parent state update
  // (e.g. an inline editor expanding into a tall region-picker tree) resizes in between renders,
  // not in between `open` toggles, so keying off `open` alone leaves the panel measuring its own
  // stale, now-too-small clamp for one paint — long enough to grow real page scroll — before a
  // ResizeObserver callback (an unrelated event loop tick) gets around to fixing it. Re-measuring
  // synchronously on every commit closes that gap; the ResizeObserver stays as a backstop for
  // resizes that happen without a React re-render at all (e.g. late image/font load reflow).
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
      // A single clamp per axis, not two separate "fix the bottom, then fix the top" checks —
      // the old version corrected an overflowing edge using a STALE reading of the opposite
      // edge (taken before that correction), so a panel taller than the viewport could get
      // "fix bottom" (pushing top negative) on one pass, then "fix top" (pushing top back down,
      // re-creating the bottom overflow the very same amount) on the next, oscillating forever
      // between the two — a real infinite loop, not just a one-off mispositioning, since each
      // pass's correction was computed from the position the OTHER correction had just produced.
      // Clamping top/left directly into their valid ranges is a pure function of the window and
      // the panel's own (already-rendered) size, so it always lands on the same answer in one
      // step no matter which edge overflowed first — when the panel is genuinely taller/wider
      // than the viewport, this settles at `margin` and lets its own overflow-y-auto handle the
      // rest, instead of continuing to chase a position that satisfies both edges at once.
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
            // Belt-and-suspenders on top of reposition()'s own clamp above — caps how big the
            // panel can ever actually render regardless of what its own width/height classes
            // say, so a panel whose intrinsic size the measurement got wrong (or that grows
            // after this was computed) still physically cannot cover the whole window.
            maxWidth: "calc(100vw - 16px)",
            maxHeight: "calc(100vh - 16px)",
          }
        : anchorPoint
          ? // First paint, before the effect above measures the real panel size and clamps it —
            // pin it at the raw click point so it never flashes at (0,0) first.
            { position: "fixed", top: anchorPoint.y, left: anchorPoint.x, right: "auto", visibility: "hidden" }
          : undefined,
    });

  if (anchorPoint) {
    // No "⋯" trigger in right-click mode — the menu is already open at the point the user
    // clicked, portaled straight to body so it isn't clipped by MasonryGrid's overflow-hidden
    // tiles the way a normal tile-anchored panel would be.
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
      {/* Attaching panelRef (and the fixed-position override) directly to the caller's own panel
         element via cloneElement, rather than wrapping it in an extra div, matters: a wrapper
         div here would itself be a normal static element whose only child is the caller's
         absolutely-positioned panel — an absolutely-positioned child doesn't contribute to its
         static parent's box size, so the wrapper would collapse to 0x0 at the trigger's own
         position, and every overflow measurement above would read that empty wrapper instead of
         the real, visible panel. */}
      {panel}
    </div>
  );
}
