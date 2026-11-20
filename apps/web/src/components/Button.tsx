import type { ComponentPropsWithRef } from "react";
import { useTooltip, type TooltipContent } from "./Tooltip";
import InlineSpinner, { type SpinnerTone } from "./InlineSpinner";
import {
  buttonClasses,
  iconButtonClasses,
  type ButtonSize,
  type ButtonVariant,
  type IconButtonTone,
} from "../lib/buttonClasses";

export type { ButtonSize, ButtonVariant };

export type ButtonProps = ComponentPropsWithRef<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  // Shows a spinner and disables the button while an action is in flight.
  loading?: boolean;
  /** Name, shortcut and a plain line on hover and keyboard focus. */
  tooltip?: TooltipContent;
};

const SPINNER_TONE: Record<ButtonVariant, SpinnerTone> = {
  primary: "onAccent",
  danger: "onAccent",
  secondary: "accent",
  ghost: "accent",
  link: "accent",
};

type Handlers = Record<string, unknown>;

/** Tooltip handlers merged over the caller's own, so neither side loses its ref or events. */
export function withTooltip(tip: Handlers, own: Handlers): Handlers {
  const out: Handlers = { ...tip };
  for (const k of Object.keys(tip)) {
    const mine = own[k];
    if (k === "ref" && mine) {
      out.ref = (el: HTMLElement | null) => {
        (tip.ref as (e: HTMLElement | null) => void)(el);
        if (typeof mine === "function") mine(el);
        else (mine as { current: unknown }).current = el;
      };
    } else if (typeof mine === "function" && typeof tip[k] === "function") {
      out[k] = (...a: unknown[]) => {
        (mine as (...x: unknown[]) => void)(...a);
        (tip[k] as (...x: unknown[]) => void)(...a);
      };
    }
  }
  return out;
}

export default function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  type = "button",
  className = "",
  children,
  tooltip,
  ...rest
}: ButtonProps) {
  const tip = useTooltip(tooltip);
  return (
    <>
      <button
        type={type}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        // Marks the action Enter should fire in a dialog.
        data-primary={variant === "primary" || variant === "danger" || undefined}
        className={buttonClasses(variant, size, className)}
        {...rest}
        {...withTooltip(tip.props, rest)}
      >
        {loading && <InlineSpinner tone={SPINNER_TONE[variant]} />}
        {children}
      </button>
      {tip.node}
    </>
  );
}

export type IconButtonProps = Omit<ComponentPropsWithRef<"button">, "aria-label"> & {
  /** Required: an icon alone says nothing to a screen reader. Also the hover tooltip. */
  "aria-label": string;
  tone?: IconButtonTone;
  /** A toolbar toggle that's on (a panel it opens is showing). */
  active?: boolean;
  /** Adds a shortcut and a plain line to the hover; the label is the aria-label. */
  tooltip?: Omit<TooltipContent, "label"> & { label?: string };
};

/** A button that is only an icon. */
export function IconButton({
  tone = "toolbar",
  active = false,
  type = "button",
  className = "",
  title,
  tooltip,
  ...rest
}: IconButtonProps) {
  const tip = useTooltip({ ...tooltip, label: tooltip?.label ?? title ?? rest["aria-label"] });
  return (
    <>
      <button
        type={type}
        className={iconButtonClasses(tone, active, className)}
        {...rest}
        {...withTooltip(tip.props, rest)}
      />
      {tip.node}
    </>
  );
}
