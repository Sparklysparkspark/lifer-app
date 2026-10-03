import type { SelectHTMLAttributes } from "react";

// The app's one <select> styling, in two variants: a compact toolbar control and a full-width
// form field.
export default function Select({
  variant = "toolbar",
  label,
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  variant?: "toolbar" | "form";
  /** The standard toolbar label ("Sort", "Group") in front of the select. */
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
