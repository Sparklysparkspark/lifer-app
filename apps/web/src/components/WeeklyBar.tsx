import { useState } from "react";

// Roughly one label per month across 52 ISO weeks (~4.33 weeks/month) — approximate by design,
// this is a visual axis reference, not a claim that week N always falls in a specific month.
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// eBird/Merlin-style weekly observation bar — 52 real ISO-week bars, unlike SeasonalityBar's
// 12 monthly ones. Only populated by the bulk province-refresh path (compute-provinces-bulk.ts),
// so most regions still show nothing until that recompute reaches them.
export default function WeeklyBar({ weeklyFrequency }: { weeklyFrequency: number[] | null }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!weeklyFrequency || weeklyFrequency.every((v) => v === 0)) return null;

  const max = Math.max(...weeklyFrequency);

  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">Observations by week</p>
      <div className="relative">
        {hoverIdx != null && (
          <div
            className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-1.5 py-0.5 text-[10px] font-medium text-canvas"
            style={{ left: `${((hoverIdx + 0.5) / 52) * 100}%` }}
          >
            Week {hoverIdx + 1}: {weeklyFrequency[hoverIdx]} record{weeklyFrequency[hoverIdx] === 1 ? "" : "s"}
          </div>
        )}
        <div className="flex h-10 items-end gap-px" onMouseLeave={() => setHoverIdx(null)}>
          {weeklyFrequency.map((value, i) => (
            <div
              key={i}
              className={`flex-1 rounded-sm transition-colors ${hoverIdx === i ? "bg-accent" : "bg-muted"}`}
              style={{ height: `${max ? Math.max((value / max) * 100, value > 0 ? 4 : 0) : 0}%` }}
              onMouseEnter={() => setHoverIdx(i)}
            />
          ))}
        </div>
        <div className="mt-0.5 flex text-[9px] text-muted">
          {MONTH_LABELS.map((label) => (
            <span key={label} className="flex-1 text-center">
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
