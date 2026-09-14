import type { SelectHTMLAttributes } from "react";

// One shared <select> styling for the whole app — previously every page independently
// hand-rolled its own combination of height/padding/text-size/color (CollectionPage's
// Group/Sort, SpeciesDetailPage's photo Sort, StatsPage's year pickers, Settings'
// reimport-source picker, VolumeDestinationPicker, SpeciesHotspotMap's week picker — no two
// quite alike), which is exactly the kind of drift a shared component exists to prevent.
//
// Two deliberate variants, not one: a compact toolbar control (Collection's Group/Sort/Taxon
// row, a photo grid's Sort) and a full-width form field (a Settings card, a picker dialog) are
// genuinely different contexts — same as an <input> looks different in a toolbar vs a form —
// so this offers both instead of forcing one look everywhere.
export default function Select({
  variant = "toolbar",
  label,
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  variant?: "toolbar" | "form";
  /** Renders the standard "Sort"/"Group"-style toolbar label in front of the select, at the
   *  one consistent size (text-xs) every such label should use — pass this instead of
   *  hand-wrapping the select in your own `<label>`, so a page can't drift to some other size. */
  label?: string;
}) {
  const variantClasses =
    variant === "toolbar"
      ? "h-7 rounded-md border border-line bg-surface px-2 py-1 text-xs font-medium text-muted"
      : "w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink";
  const select = <select {...props} className={`${variantClasses} ${className ?? ""}`} />;
  if (!label) return select;
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      {label}
      {select}
    </label>
  );
}
