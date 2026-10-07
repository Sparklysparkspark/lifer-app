import type { ComponentPropsWithRef } from "react";
import InlineSpinner, { type SpinnerTone } from "./InlineSpinner";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "../lib/buttonClasses";

export type { ButtonSize, ButtonVariant };

export type ButtonProps = ComponentPropsWithRef<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  // Shows a spinner and disables the button while an action is in flight.
  loading?: boolean;
};

const SPINNER_TONE: Record<ButtonVariant, SpinnerTone> = {
  primary: "onAccent",
  danger: "onAccent",
  secondary: "accent",
  ghost: "accent",
};

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
