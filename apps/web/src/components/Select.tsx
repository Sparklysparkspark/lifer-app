import type { SelectHTMLAttributes } from "react";
import { FIELD, FIELD_HEIGHT } from "../lib/fieldClasses";

// The app's one <select> styling, in two variants: a compact toolbar control and a full-width
// form field.
export default function Select({
  variant = "toolbar",
  label,
  labelClassName = "flex items-center gap-1.5 text-footnote text-muted",
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  variant?: "toolbar" | "form";
  /** The standard toolbar label ("Sort", "Group") in front of the select. */
  label?: string;
  /** For a label laid out by its container, e.g. "contents" in a label/control grid. */
  labelClassName?: string;
}) {
  const variantClasses =
    variant === "toolbar"
      ? "h-8 rounded-control border border-control-line bg-control px-2 text-footnote font-medium text-ink shadow-xs focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50"
      : `${FIELD} ${FIELD_HEIGHT.md}`;
  // Named directly too: a label laid out with display: contents isn't always announced.
  const select = <select aria-label={label} {...props} className={`${variantClasses} ${className ?? ""}`} />;
  if (!label) return select;
  return (
    <label className={labelClassName}>
      {label}
      {select}
    </label>
  );
}
