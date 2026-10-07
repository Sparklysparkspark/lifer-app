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
  const sizeClasses = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-xs font-medium";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center justify-center rounded-md border transition-colors ${sizeClasses} ${
        active ? "border-accent bg-accent text-accent-fg" : "border-line text-muted hover:bg-surface-muted"
      } ${className ?? ""}`}
    >
      {children}
    </button>
  );
}
