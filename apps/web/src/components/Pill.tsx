import { useLayoutEffect, useRef, useState } from "react";
import { useTooltip } from "./Tooltip";

// The shared toggle button: filled when active, muted when not. Rounded-md like the app's other
// controls rather than a true pill shape.
export default function Pill({
  active,
  onClick,
  children,
  size = "md",
  wrap = false,
  fullName,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  /** "sm" for tab-style rows, "md" for standalone buttons. */
  size?: "sm" | "md";
  /** Long text wraps onto more lines instead of being cut, for a list row's small button. */
  wrap?: boolean;
  /** The full text for the tooltip when the label is cut; defaults to a plain-text label. */
  fullName?: string;
  className?: string;
}) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const name = fullName ?? (typeof children === "string" ? children : undefined);
  useLayoutEffect(() => {
    const el = labelRef.current;
    setCut(!!el && !wrap && el.scrollWidth > el.clientWidth);
  }, [children, wrap]);
  const tooltip = useTooltip(cut && name ? { label: name } : undefined);
  // One height for every toolbar control (Button sm, Select, the search box).
  const sizeClasses = `${wrap ? "min-h-8 py-1 text-left" : "h-8"} ${size === "sm" ? "px-2.5" : "px-3"} text-footnote font-medium`;
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        {...tooltip.props}
        className={`inline-flex min-w-0 max-w-full items-center justify-center rounded-control border transition-colors ${sizeClasses} ${
          active
            ? "border-accent bg-accent text-accent-fg hover:bg-accent/90"
            : "border-control-line bg-control text-ink shadow-xs hover:bg-surface-muted"
        } ${className ?? ""}`}
      >
        <span ref={labelRef} className={wrap ? "min-w-0 break-words" : "min-w-0 truncate"}>
          {children}
        </span>
      </button>
      {tooltip.node}
    </>
  );
}
