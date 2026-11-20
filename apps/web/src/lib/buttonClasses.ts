// The button look as a class string, for links and labels styled as buttons (components/Button.tsx).
// "link" is a plain text action ("Clear", "Show all"), sized by its text alone.
export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "link";
export type ButtonSize = "sm" | "md" | "lg";

// Every variant carries a 1px border (transparent where unseen) so mixed buttons in a row line up.
const BASE =
  "inline-flex items-center justify-center gap-2 rounded-control border font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:border-transparent focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-accent text-accent-fg hover:bg-accent/90",
  secondary: "border-control-line bg-control text-ink shadow-xs hover:bg-surface-muted",
  danger: "border-transparent bg-red-600 text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600",
  ghost: "border-transparent text-muted hover:bg-surface-muted hover:text-ink",
  link: "border-transparent text-muted underline-offset-2 hover:text-ink hover:underline",
};

// "sm" is the toolbar size: the same 32px height as Select, Pill and the search box beside it.
const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-footnote",
  // The form size: the same 38px as a TextField, so a field and its button line up.
  md: "h-9.5 px-4 text-callout",
  // A screen's one main action (setup, empty states).
  lg: "h-11 px-6 text-body",
};

const LINK_SIZE: Record<ButtonSize, string> = { sm: "text-footnote", md: "text-callout", lg: "text-body" };

export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md", className = ""): string {
  const sizeClasses = variant === "link" ? LINK_SIZE[size] : SIZE[size];
  return `${BASE} ${VARIANT[variant]} ${sizeClasses} ${className}`.trim();
}

// Icon-only buttons: "toolbar" sits beside the 32px toolbar controls, "plain" is a bare glyph
// (a chip's remove, a row's info).
export type IconButtonTone = "toolbar" | "plain" | "overlay";
export const OVERLAY_PILL =
  // design-token: the flat dark oval pill over a photo (the Gallery tile's ⋯ and the iNaturalist cards' Preview and ⋯), one size so a pair always matches.
  "inline-flex h-5 w-7 items-center justify-center rounded-full bg-black/40 text-footnote leading-none text-white hover:bg-black/60";
// Overlay controls stay out of the photo until it's hovered or holds keyboard focus; touch screens
// have no hover, so they always show there.
export const OVERLAY_REVEAL =
  "pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100 pointer-fine:focus-visible:opacity-100";
const ICON_TONE: Record<IconButtonTone, string> = {
  toolbar: "h-8 w-8 border-control-line bg-control text-ink shadow-xs hover:bg-surface-muted",
  plain: "h-6 min-w-6 border-transparent text-muted hover:text-ink",
  // A fixed box with no padding, so every overlay pill (Preview, ⋯) is exactly the same size.
  overlay: `${OVERLAY_PILL} border-transparent rounded-full! gap-0 px-0!`,
};
const ICON_ACTIVE = "h-8 w-8 border-transparent bg-accent text-accent-fg hover:bg-accent/90";

export function iconButtonClasses(tone: IconButtonTone = "toolbar", active = false, className = ""): string {
  return `${BASE} ${active ? ICON_ACTIVE : ICON_TONE[tone]} ${className}`.trim();
}
