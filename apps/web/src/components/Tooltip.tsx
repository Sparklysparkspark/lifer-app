import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { matches } from "../lib/keymap";
import { createPortal } from "react-dom";
import { placeCard, type Box } from "../lib/cardPlacement";

export interface TooltipContent {
  /** What the control is called. */
  label: string;
  /** Shortcut labels as shown ("⌘B"), from the keymap. */
  shortcut?: string;
  /** One plain line about what it does. */
  description?: string;
}

const DELAY_MS = 600;
const GAP = 8;
const EDGE = 8;

// One tooltip at a time: opening one closes the previous.
let closeActive: (() => void) | null = null;

function menuOpen(): boolean {
  return !!document.querySelector('[role="menu"], [role="dialog"]');
}

/** Hover (after a short delay) and keyboard focus tooltip for a control. Spread `props` on the
 *  control and render `node` beside it; the bubble is portalled so no parent clips it. */
export function useTooltip(content: TooltipContent | undefined): { props: Record<string, unknown>; node: ReactNode } {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();

  const close = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
  }, []);
  const show = useCallback(
    (delay: number) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (menuOpen()) return;
        closeActive?.();
        closeActive = close;
        setOpen(true);
      }, delay);
    },
    [close],
  );
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (closeActive === close) closeActive = null;
    },
    [close],
  );
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => matches(e, "close") && close();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", close, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", close, true);
    };
  }, [open, close]);

  if (!content) return { props: {}, node: null };
  return {
    props: {
      ref: setAnchor,
      "aria-describedby": open ? id : undefined,
      onPointerEnter: (e: React.PointerEvent) => e.pointerType === "mouse" && show(DELAY_MS),
      onPointerLeave: close,
      // target: a label's tooltip opens when its input takes keyboard focus.
      onFocus: (e: React.FocusEvent<HTMLElement>) => e.target.matches(":focus-visible") && show(0),
      onBlur: close,
    },
    node: open && anchor ? <Bubble id={id} anchor={anchor} content={content} /> : null,
  };
}

/** The same tooltip for a control that isn't a Button (a thumbnail, a coloured pill): pass the
 *  props to the control. Merge `props.ref` by hand when the control has its own ref. */
export function Tooltip({
  content,
  children,
}: {
  content: TooltipContent | undefined;
  children: (props: Record<string, unknown> & { ref?: (el: HTMLElement | null) => void }) => ReactNode;
}) {
  const tip = useTooltip(content);
  return (
    <>
      {children(tip.props)}
      {tip.node}
    </>
  );
}

function Bubble({ id, anchor, content }: { id: string; anchor: HTMLElement; content: TooltipContent }) {
  return (
    <Floating id={id} rect={anchor.getBoundingClientRect()}>
      <div className="flex items-center gap-2">
        <span className="font-medium">{content.label}</span>
        {content.shortcut && (
          <kbd className="rounded-badge border border-control-line bg-control px-1.5 font-mono text-caption text-muted">
            {content.shortcut}
          </kbd>
        )}
      </div>
      {content.description && <p className="mt-0.5 text-muted">{content.description}</p>}
    </Floating>
  );
}

type Rect = Pick<DOMRect, "top" | "bottom" | "left" | "width">;

// Below the anchor, flipped above near the bottom, kept inside the window.
function Floating({
  id,
  rect,
  className,
  interactive,
  place,
  children,
}: {
  id?: string;
  rect: Rect;
  className?: string;
  interactive?: { label: string; onPointerEnter: () => void; onPointerLeave: () => void };
  /** Its own placement for the measured size, instead of below or above the anchor. */
  place?: (size: { width: number; height: number }) => { top: number; left: number };
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const { top, bottom, left: x, width: w } = rect;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const below = bottom + GAP + height <= window.innerHeight - EDGE;
    const left = Math.min(Math.max(EDGE, x + w / 2 - width / 2), window.innerWidth - width - EDGE);
    const placed = place?.({ width, height });
    const next = placed
      ? { top: placed.top, left: placed.left }
      : { top: below ? bottom + GAP : Math.max(EDGE, top - GAP - height), left };
    // Again when the content changes (photos arriving); unchanged keeps the state.
    setPos((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
  }, [top, bottom, x, w, children, place]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role={interactive ? "group" : "tooltip"}
      aria-label={interactive?.label}
      onPointerEnter={interactive?.onPointerEnter}
      onPointerLeave={interactive?.onPointerLeave}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
      className={`${interactive ? "" : "pointer-events-none "}fixed z-50 rounded-control border border-line bg-surface px-2.5 py-1.5 text-footnote text-ink shadow-lg ${className ?? "max-w-64"}`}
    >
      {children}
    </div>,
    document.body,
  );
}

/** The same bubble at a point on screen (a dot on a map) with richer content. It never takes focus
 *  or pointer events, so the thing under it keeps working. */
export function PointTooltip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <Floating rect={{ top: y - 10, bottom: y + 10, left: x, width: 0 }} className="max-w-80">
      {children}
    </Floating>
  );
}

/** The same bubble, but one the pointer can move into and use (a map dot's photos): it takes
 *  pointer events, and sits beside a mark of radius `avoid` without covering it. With `within` it
 *  stays inside that box (the map) and clear of `obstacles` (its controls) where it can. */
export function PointCard({
  x,
  y,
  avoid,
  label,
  within,
  obstacles,
  onPointerEnter,
  onPointerLeave,
  children,
}: {
  x: number;
  y: number;
  avoid: number;
  label: string;
  within?: Box;
  obstacles?: Box[];
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  children: ReactNode;
}) {
  return (
    <Floating
      rect={{ top: y - avoid, bottom: y + avoid, left: x, width: 0 }}
      className="max-w-80"
      interactive={{ label, onPointerEnter, onPointerLeave }}
      place={within ? (card) => placeCard({ area: within, mark: { x, y, r: avoid }, card, obstacles }) : undefined}
    >
      {children}
    </Floating>
  );
}
