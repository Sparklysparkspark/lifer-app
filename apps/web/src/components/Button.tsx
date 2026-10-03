import type { ComponentPropsWithRef } from "react";
import InlineSpinner, { type SpinnerTone } from "./InlineSpinner";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

export type ButtonProps = ComponentPropsWithRef<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  // Shows a spinner and disables the button while an action is in flight.
  loading?: boolean;
};

// Every variant carries a 1px border (transparent where unseen) so mixed buttons in a row line up.
const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md border font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-accent text-accent-fg hover:bg-accent/90",
  secondary: "border-line text-ink hover:bg-surface-muted",
  danger: "border-transparent bg-red-600 text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600",
  ghost: "border-transparent text-muted hover:bg-surface-muted hover:text-ink",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-sm",
  md: "px-4 py-2 text-sm",
};

const SPINNER_TONE: Record<ButtonVariant, SpinnerTone> = { primary: "onAccent", danger: "onAccent", secondary: "accent", ghost: "accent" };

export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md", className = ""): string {
  return `${BASE} ${VARIANT[variant]} ${SIZE[size]} ${className}`.trim();
}

export default function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  type = "button",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, className)}
      {...rest}
    >
      {loading && <InlineSpinner tone={SPINNER_TONE[variant]} />}
      {children}
    </button>
  );
}
