// The "rounded border, filled+dark when active, muted when not" toggle button that was
// independently hand-styled in several places (OfflinePacksPage's sea-zone/taxon tabs, Gallery's
// Filters button, StatsPage's tab-style controls) with the same two class strings retyped each
// time. One shared component means a future style tweak (e.g. the active color) happens once,
// not once per page that happened to copy it. Rounded-rectangle, not pill-shaped (rounded-full)
// — matches the rounded-lg/rounded-md corner language used everywhere else in the app (Settings
// cards, Collection's group-by controls), rather than standing out as its own separate shape
// language just because it happens to be a toggle.
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
  /** "sm" matches the tighter tab-style pills (OfflinePacksPage's sea-zone tabs); "md" is the
   *  default, slightly roomier button size (Gallery's Filters button). */
  size?: "sm" | "md";
  className?: string;
}) {
  const sizeClasses = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-xs font-medium";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center justify-center rounded-md border transition-colors ${sizeClasses} ${
        active ? "border-accent bg-accent text-accent-fg" : "border-line text-muted hover:bg-surface-muted"
      } ${className ?? ""}`}
    >
      {children}
    </button>
  );
}
