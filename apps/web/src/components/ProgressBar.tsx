import { progressDisplay } from "../lib/progressDisplay";

export type ProgressBarSize = "xs" | "sm";
export type ProgressBarTone = "accent" | "ink";

const HEIGHT: Record<ProgressBarSize, string> = { xs: "h-1", sm: "h-1.5" };
const FILL: Record<ProgressBarTone, string> = { accent: "bg-accent", ink: "bg-ink" };

// One bar for every job. The track stays mounted across determinate and indeterminate states so
// switching phases never makes the layout jump; resetKey remounts only the fill.
export default function ProgressBar({
  value,
  size = "sm",
  tone = "accent",
  label,
  showPercent = false,
  resetKey,
  determinate = false,
  className = "",
}: {
  value: number | null;
  size?: ProgressBarSize;
  tone?: ProgressBarTone;
  label?: string;
  showPercent?: boolean;
  resetKey?: string;
  // For stats like "collected of total", where 0 is a real value: an empty track, never a stripe.
  determinate?: boolean;
  className?: string;
}) {
  const shown = progressDisplay(value);
  const { indeterminate, widthPct, percent } =
    determinate && shown.indeterminate ? { indeterminate: false, widthPct: 0, percent: 0 } : shown;
  const aria = indeterminate
    ? { "aria-label": label }
    : { "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": percent };

  const track = (
    <div
      role="progressbar"
      {...aria}
      className={`relative ${HEIGHT[size]} w-full overflow-hidden rounded-full bg-surface-muted`}
    >
      {indeterminate ? (
        <div
          key={`i-${resetKey ?? ""}`}
          className={`progress-indeterminate absolute inset-y-0 left-0 w-2/5 rounded-full ${FILL[tone]}`}
        />
      ) : (
        <div
          key={`d-${resetKey ?? ""}`}
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${FILL[tone]}`}
          style={{ width: `${widthPct}%` }}
        />
      )}
    </div>
  );

  if (!showPercent) return <div className={className}>{track}</div>;
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="min-w-0 flex-1">{track}</div>
      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted">
        {indeterminate ? "" : `${percent}%`}
      </span>
    </div>
  );
}
