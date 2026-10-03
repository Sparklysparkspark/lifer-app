export type SpinnerSize = "xs" | "sm" | "md";
export type SpinnerTone = "accent" | "ink" | "onAccent";

const SIZE: Record<SpinnerSize, string> = { xs: "h-3 w-3", sm: "h-4 w-4", md: "h-6 w-6" };
const TONE: Record<SpinnerTone, string> = {
  accent: "border-accent/35 border-t-accent",
  ink: "border-ink/30 border-t-ink",
  onAccent: "border-accent-fg/35 border-t-accent-fg",
};

// The one spinner style for the app. Decorative (aria-hidden) unless given a label.
export default function InlineSpinner({
  size = "xs",
  tone = "accent",
  label,
  className = "",
}: {
  size?: SpinnerSize;
  tone?: SpinnerTone;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-block shrink-0 animate-spin rounded-full border-2 ${SIZE[size]} ${TONE[tone]} ${className}`}
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}
