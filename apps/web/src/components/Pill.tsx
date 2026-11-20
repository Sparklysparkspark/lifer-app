// The shared toggle button: filled when active, muted when not. Rounded-md like the app's other
// controls rather than a true pill shape.
export default function Pill({
  active,
  onClick,
  children,
  size = "md",
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  /** "sm" for tab-style rows, "md" for standalone buttons. */
  size?: "sm" | "md";
  className?: string;
}) {
  // One height for every toolbar control (Button sm, Select, the search box).
  const sizeClasses = size === "sm" ? "h-8 px-2.5 text-footnote font-medium" : "h-8 px-3 text-footnote font-medium";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center justify-center rounded-control border transition-colors ${sizeClasses} ${
        active
          ? "border-accent bg-accent text-accent-fg hover:bg-accent/90"
          : "border-control-line bg-control text-ink shadow-xs hover:bg-surface-muted"
      } ${className ?? ""}`}
    >
      {children}
    </button>
  );
}
