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
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [fixedPosition, setFixedPosition] = useState<{ top: number; left: number } | null>(null);

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
  useLayoutEffect(() => {
    if (!open) {
      setFixedPosition(null);
      return;
    }
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const bottomOverflow = rect.bottom - window.innerHeight;
    const rightOverflow = rect.right - window.innerWidth;
    const topOverflow = margin - rect.top;
    const leftOverflow = margin - rect.left;
    if (bottomOverflow <= 0 && rightOverflow <= 0 && topOverflow <= 0 && leftOverflow <= 0) {
      setFixedPosition(null);
      return;
    }
    let top = rect.top;
    let left = rect.left;
    if (bottomOverflow > 0) top -= bottomOverflow + margin;
    if (topOverflow > 0) top = margin;
    if (rightOverflow > 0) left -= rightOverflow + margin;
    if (leftOverflow > 0) left = margin;
    setFixedPosition({ top, left });
  }, [open]);

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
      {open &&
        isValidElement(children) &&
        cloneElement(children as ReactElement<{ ref?: RefObject<HTMLDivElement | null>; style?: CSSProperties }>, {
          ref: panelRef,
          style: fixedPosition
            ? { position: "fixed", top: fixedPosition.top, left: fixedPosition.left, right: "auto" }
            : undefined,
        })}
    </div>
  );
}
