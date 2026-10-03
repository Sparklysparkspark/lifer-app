export interface ProgressDisplay {
  indeterminate: boolean;
  // Fill width in percent, unrounded, with a 2% floor so a just-started bar is visible.
  widthPct: number;
  // Whole percent for text, from the real value (not the 2% floor).
  percent: number;
}

const MIN_VISIBLE_PCT = 2;

// null, NaN or <= 0 means "no measurable progress yet", which shows as indeterminate rather
// than an empty track that reads as a thin broken line.
export function progressDisplay(value: number | null | undefined): ProgressDisplay {
  if (value == null || !Number.isFinite(value) || value <= 0) return { indeterminate: true, widthPct: 0, percent: 0 };
  const clamped = Math.min(1, value);
  return { indeterminate: false, widthPct: Math.max(MIN_VISIBLE_PCT, clamped * 100), percent: Math.floor(clamped * 100) };
}

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
    <div role="progressbar" {...aria} className={`relative ${HEIGHT[size]} w-full overflow-hidden rounded-full bg-surface-muted`}>
      {indeterminate ? (
        <div key={`i-${resetKey ?? ""}`} className={`progress-indeterminate absolute inset-y-0 left-0 w-2/5 rounded-full ${FILL[tone]}`} />
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
      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted">{indeterminate ? "" : `${percent}%`}</span>
    </div>
  );
}
