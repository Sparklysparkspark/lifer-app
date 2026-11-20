import { useEffect, useId, useRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { useTooltip } from "./Tooltip";

export type CheckboxProps = Omit<ComponentPropsWithoutRef<"input">, "type" | "onChange" | "size" | "children"> & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The visible label; leave it out only with an aria-label. */
  children?: ReactNode;
  /** A muted line under the label, read out as its description. */
  description?: ReactNode;
  /** Shown as a dash: some, not all, of a group is checked. */
  indeterminate?: boolean;
  /** "sm" in menus and toolbars, "md" in forms. */
  size?: "sm" | "md";
  /** A tooltip on hover and keyboard focus. */
  title?: string;
  labelClassName?: string;
};

// The one checkbox: a native input in its label, so a click on the text toggles it.
export default function Checkbox({
  checked,
  onChange,
  children,
  description,
  indeterminate = false,
  size = "md",
  title,
  disabled,
  className = "",
  labelClassName = "",
  ...rest
}: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  const descriptionId = useId();
  // indeterminate is a DOM property only, with no attribute.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  const tip = useTooltip(title ? { label: title } : undefined);
  const label = (
    <label
      {...tip.props}
      className={`flex items-center gap-2 ${size === "sm" ? "text-footnote" : "text-callout"} ${disabled ? "text-muted" : "text-ink"} ${description ? "" : className} ${labelClassName}`.trim()}
    >
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={description ? descriptionId : undefined}
        className="h-4 w-4 shrink-0 accent-accent disabled:cursor-not-allowed"
        {...rest}
      />
      {children}
      {tip.node}
    </label>
  );
  if (!description) return label;
  return (
    <div className={className}>
      {label}
      <p id={descriptionId} className="mt-0.5 pl-6 text-footnote text-muted">
        {description}
      </p>
    </div>
  );
}
